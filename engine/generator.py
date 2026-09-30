"""
Level Generation Pipeline
=========================

        Generate candidate board      (reverse construction - see below)
                ↓
        Validate mathematical constraints
                ↓
        Solve board                   (engine.solver.solve)
                ↓
        Calculate difficulty          (measure -> difficulty score -> tier)
                ↓
        Reject / accept               (keep the candidate closest to the target tier)
                ↓
        Deliver level

Reverse construction
--------------------
Boards are built backwards: we start from an empty grid and repeatedly drop a
matching pair onto two empty cells that are *connected at that moment*. Played
forwards, the pairs can be removed in exactly the reverse order, so every
candidate is solvable by construction (before frozen tiles are added - those
are re-checked by the solver).

Everything is driven by a `random.Random(seed)` instance, so the same seed
always produces the same board. That is what makes the Daily Challenge and the
level packs reproducible.
"""
from __future__ import annotations

import hashlib
import math
import random
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .rules import BLOCKED, EMPTY, WILD, Pos, find_pairs, tiles_left
from .rules import apply_move, validate_move
from .solver import SolveResult, random_playout, solve

TIERS = ["EASY", "MEDIUM", "HARD", "EXPERT"]
TIER_THRESHOLDS = [(24, "EASY"), (40, "MEDIUM"), (55, "HARD")]  # else EXPERT
ALL_DIRS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class LevelSpec:
    rows: int = 5
    cols: int = 5
    fill: float = 1.0            # fraction of free cells that get a tile (1.0 = full board)
    blocked: int = 0             # number of wall cells
    frozen: int = 0              # number of frozen tiles
    wild: int = 0                # number of wildcard tiles
    target: Optional[str] = None # EASY / MEDIUM / HARD / EXPERT, or None = accept first valid
    low_first_moves: bool = False  # Chain mode: few moves available at the start
    max_attempts: int = 10
    rollouts: int = 16
    solve_budget: int = 400


@dataclass
class Level:
    grid: List[List[int]]
    frozen: List[Pos]
    seed: int
    metrics: Dict
    difficulty: str
    difficulty_score: float
    attempts: int
    solution: List = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["frozen"] = [list(p) for p in self.frozen]
        d["solution"] = [[list(a), list(b)] for a, b in self.solution]
        return d


def seed_from(*parts) -> int:
    """Stable integer seed from arbitrary parts (independent of PYTHONHASHSEED)."""
    h = hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()
    return int(h[:12], 16)


# --------------------------------------------------------------------------
# 1. Candidate generation
# --------------------------------------------------------------------------
def _reachable_empties(grid, a: Pos) -> List[Tuple[Pos, str]]:
    """Empty cells b such that a and b would be connected if both were filled."""
    rows, cols = len(grid), len(grid[0])
    out = []
    for dr, dc in ALL_DIRS:
        r, c = a[0] + dr, a[1] + dc
        kind = "row" if dr == 0 else "column" if dc == 0 else "diagonal"
        while 0 <= r < rows and 0 <= c < cols and grid[r][c] == EMPTY:
            out.append(((r, c), kind))
            r += dr
            c += dc
    # row wrap forwards / backwards in reading order
    total = rows * cols
    ia = a[0] * cols + a[1]
    for step in (1, -1):
        i = ia + step
        while 0 <= i < total:
            r, c = divmod(i, cols)
            if grid[r][c] != EMPTY:
                break
            if r != a[0]:
                out.append(((r, c), "wrap"))
            i += step
    return out


def _pair_values(rng: random.Random, wild: bool) -> Tuple[int, int]:
    if wild:
        return WILD, rng.randint(1, 9)
    if rng.random() < 0.5:
        n = rng.randint(1, 9)
        return n, n
    a = rng.randint(1, 9)
    return a, 10 - a


def _reverse_build(spec: LevelSpec, rng: random.Random, spread: float) -> Optional[Tuple[List[List[int]], int]]:
    """Fill the board pair by pair so it is solvable by construction.

    Uses "most constrained cell first": the empty cell with the fewest possible
    partners is filled next, so no cell gets stranded without a partner. If a
    cell does become stranded the attempt restarts; the fullest attempt wins.
    """
    rows, cols = spec.rows, spec.cols
    cells = [(r, c) for r in range(rows) for c in range(cols)]
    blocked_count = min(spec.blocked, len(cells) - 4)
    if (len(cells) - blocked_count) % 2:          # keep an even number of free cells
        blocked_count += 1 if blocked_count or spec.fill >= 1.0 else 0
    blocked = rng.sample(cells, blocked_count)
    free = len(cells) - blocked_count
    n_pairs = max(2, int(free * spec.fill + 1e-9) // 2)
    wild_pairs = set(rng.sample(range(n_pairs), min(spec.wild, n_pairs)))

    best = None
    for _attempt in range(40):
        grid = [[EMPTY] * cols for _ in range(rows)]
        for (r, c) in blocked:
            grid[r][c] = BLOCKED
        order: List[Tuple[Pos, Pos]] = []
        for k in range(n_pairs):
            empties = [(r, c) for r in range(rows) for c in range(cols) if grid[r][c] == EMPTY]
            if len(empties) < 2:
                break
            options = {e: _reachable_empties(grid, e) for e in empties}
            if spec.fill >= 1.0 and any(not v for v in options.values()):
                break                               # a cell can never be paired - restart
            live = [e for e in empties if options[e]]
            if not live:
                break
            fewest = min(len(options[e]) for e in live)
            pool = [e for e in live if len(options[e]) <= fewest + (0 if spec.fill >= 1.0 else 3)]
            a = rng.choice(pool)
            cands = options[a]

            # spread in [0,1]: 0 prefers neighbours, 1 prefers far-apart / wrap pairs
            def dist(item):
                (r, c), kind = item
                d = max(abs(r - a[0]), abs(c - a[1]))
                return d + (2 if kind == "wrap" else 0) + (0.5 if kind == "diagonal" else 0)
            cands = sorted(cands, key=dist, reverse=rng.random() < spread)
            b = cands[rng.randrange(max(1, len(cands) // 3))][0]

            v1, v2 = _pair_values(rng, k in wild_pairs)
            if rng.random() < 0.5:
                v1, v2 = v2, v1
            grid[a[0]][a[1]] = v1
            grid[b[0]][b[1]] = v2
            order.append((a, b))
        if best is None or len(order) > len(best[1]):
            best = (grid, order)
        if len(order) == n_pairs:
            break
    if best is None or len(best[1]) < 2:
        return None
    # Removing pairs in reverse placement order is always legal.
    return best[0], list(reversed(best[1]))


def replay(grid, frozen, path) -> Optional[List[int]]:
    """Check that `path` fully clears the board; returns branching per step or None."""
    g, f = [list(r) for r in grid], [tuple(p) for p in frozen]
    branching = []
    for p1, p2 in path:
        ok, _, _ = validate_move(g, f, p1, p2)
        if not ok:
            return None
        branching.append(len(find_pairs(g, f)))
        g, f = apply_move(g, f, p1, p2)
    return branching if tiles_left(g) == 0 else None


def known_solution(grid, frozen, path, budget: int) -> Optional[SolveResult]:
    """Build a SolveResult from the construction path (fast), or search if it no longer works."""
    branching = replay(grid, frozen, path)
    probe = solve(grid, frozen, budget=budget)       # search effort, used as a metric
    if branching is not None:
        return SolveResult(solvable=True, path=list(path), nodes=probe.nodes,
                           moves_to_clear=len(path), branching=branching)
    return probe if probe.solvable else None


def _add_frozen(grid, count: int, rng: random.Random) -> List[Pos]:
    tiles = [(r, c) for r, row in enumerate(grid) for c, v in enumerate(row) if v > 0 and v != WILD]
    return sorted(rng.sample(tiles, min(count, max(0, len(tiles) // 3))))


# --------------------------------------------------------------------------
# 2. Validation
# --------------------------------------------------------------------------
def validate(grid, frozen: Sequence[Pos], spec: Optional[LevelSpec] = None) -> Tuple[bool, str]:
    """Mathematical constraints every delivered board must satisfy."""
    values = [v for row in grid for v in row]
    tiles = [v for v in values if v > 0]
    if any(v not in (EMPTY, BLOCKED, WILD) and not 1 <= v <= 9 for v in values):
        return False, "illegal cell value"
    if len(tiles) % 2:
        return False, "odd number of tiles"
    if len(tiles) < 4:
        return False, "too few tiles"
    # Perfect-pairing feasibility on values alone (ignoring geometry):
    # count[n] and count[10-n] must be pairable; wildcards absorb leftovers.
    counts = {n: 0 for n in range(1, 10)}
    wild = 0
    for v in tiles:
        if v == WILD:
            wild += 1
        else:
            counts[v] += 1
    leftovers = counts[5] % 2
    for n in range(1, 5):
        leftovers += (counts[n] + counts[10 - n]) % 2
    if leftovers > wild or (wild - leftovers) % 2:
        return False, "values cannot be perfectly paired"
    if not find_pairs(grid, frozen):
        return False, "no opening move"
    if spec and spec.frozen and len(frozen) > len(tiles) // 3:
        return False, "too many frozen tiles"
    return True, "ok"


# --------------------------------------------------------------------------
# 3/4. Solve + measure
# --------------------------------------------------------------------------
def measure(grid, frozen=(), rng: Optional[random.Random] = None, rollouts: int = 16,
            solve_result: Optional[SolveResult] = None, budget: int = 12_000) -> Dict:
    """Board metrics used to classify difficulty."""
    rng = rng or random.Random(0)
    frozen = [tuple(p) for p in frozen]
    tiles = tiles_left(grid)
    first = find_pairs(grid, frozen)
    res = solve_result or solve(grid, frozen, budget=budget)
    outcomes = [random_playout(grid, frozen, rng) for _ in range(max(1, rollouts))]
    deadlock_prob = sum(1 for ok, _ in outcomes if not ok) / len(outcomes)
    min_moves = tiles // 2
    avg_depth = sum(d for _, d in outcomes) / len(outcomes)
    branching = (sum(res.branching) / len(res.branching)) if res.branching else float(len(first))
    blocked = sum(1 for row in grid for v in row if v == BLOCKED)
    wild = sum(1 for row in grid for v in row if v == WILD)
    metrics = {
        "rows": len(grid),
        "cols": len(grid[0]),
        "tiles": tiles,
        "valid_pairs": len(first),
        "first_moves": len(first),
        "min_moves": min_moves,
        "avg_solution_depth": round(avg_depth, 2),
        "depth_ratio": round(avg_depth / min_moves, 3) if min_moves else 1.0,
        "deadlock_probability": round(deadlock_prob, 3),
        "branching_factor": round(branching, 2),
        "solver_nodes": res.nodes,
        "solvable": res.solvable,
        "frozen": len(frozen),
        "blocked": blocked,
        "wild": wild,
    }
    score = difficulty_score(metrics)
    metrics["difficulty_score"] = score
    metrics["difficulty"] = classify(score)
    return metrics


def difficulty_score(m: Dict) -> float:
    """0-100. Weighted blend of the board metrics."""
    tiles = max(1, m["tiles"])
    size = min(1.0, max(0.0, (tiles - 8) / 40))                   # bigger boards are harder
    trap = m["deadlock_probability"]                               # random play gets stuck
    scarcity = max(0.0, 1 - m["first_moves"] / 8)                  # few obvious openings
    narrow = max(0.0, 1 - m["branching_factor"] / max(2.0, tiles / 3))  # few options along the way
    search = min(1.0, math.log10(max(1, m["solver_nodes"])) / 3.2)  # solver effort
    specials = min(1.0, (m["frozen"] * 1.5 + m["blocked"] * 0.8 - m["wild"] * 1.5) / 10)
    score = 30 * trap + 22 * size + 14 * scarcity + 12 * narrow + 8 * search + 14 * max(0.0, specials)
    return round(max(0.0, min(100.0, score)), 1)


def classify(score: float) -> str:
    for limit, name in TIER_THRESHOLDS:
        if score < limit:
            return name
    return "EXPERT"


def stars_for(tier: str) -> int:
    return {"EASY": 2, "MEDIUM": 3, "HARD": 4, "EXPERT": 5}.get(tier, 3)


# --------------------------------------------------------------------------
# 5/6. Accept / reject + deliver
# --------------------------------------------------------------------------
def generate_level(spec: LevelSpec, seed: int) -> Level:
    rng = random.Random(seed)
    target_idx = TIERS.index(spec.target) if spec.target in TIERS else None
    best: Optional[Tuple[float, Level]] = None
    attempts = 0

    for attempt in range(spec.max_attempts):
        attempts += 1
        # Nudge candidate "spread" towards the target: harder tiers -> far-apart pairs
        if target_idx is None:
            spread = rng.uniform(0.2, 0.8)
        else:
            spread = min(1.0, max(0.0, 0.15 + 0.25 * target_idx + rng.uniform(-0.15, 0.15)))
        if spec.low_first_moves:
            spread = max(spread, 0.75)
        built = _reverse_build(spec, rng, spread)
        if not built:
            continue
        grid, path = built
        frozen = _add_frozen(grid, spec.frozen, rng) if spec.frozen else []

        ok, _why = validate(grid, frozen, spec)
        if not ok:
            continue
        res = known_solution(grid, frozen, path, spec.solve_budget)
        if res is None:
            # frozen tiles broke the construction guarantee and search failed - reject
            continue
        metrics = measure(grid, frozen, rng, spec.rollouts, res)
        level = Level(grid=grid, frozen=frozen, seed=seed, metrics=metrics,
                      difficulty=metrics["difficulty"], difficulty_score=metrics["difficulty_score"],
                      attempts=attempts, solution=res.path)

        # distance to target (tier distance first, then first-moves for chain boards)
        if target_idx is None:
            dist = 0.0
        else:
            dist = abs(TIERS.index(level.difficulty) - target_idx) * 100
            centre = [12, 32, 47, 62][target_idx]
            dist += abs(level.difficulty_score - centre) / 10
        if spec.low_first_moves:
            dist += max(0.0, metrics["first_moves"] - metrics["tiles"] * 0.4) * 5
        if best is None or dist < best[0]:
            best = (dist, level)
        if dist < 3:
            break

    if best is None:
        # Guaranteed fallback: plain reverse-built board without specials.
        plain = LevelSpec(rows=spec.rows, cols=spec.cols, fill=spec.fill)
        grid, path = _reverse_build(plain, rng, 0.3)
        res = known_solution(grid, [], path, 500)
        metrics = measure(grid, [], rng, spec.rollouts, res)
        return Level(grid=grid, frozen=[], seed=seed, metrics=metrics,
                     difficulty=metrics["difficulty"], difficulty_score=metrics["difficulty_score"],
                     attempts=attempts, solution=res.path)
    best[1].attempts = attempts
    return best[1]


def inject_solvable_pair(grid, rng: random.Random) -> Optional[Tuple[Pos, Pos]]:
    """Deadlock breaker: drop a matching pair onto two *connected* empty cells."""
    empties = [(r, c) for r, row in enumerate(grid) for c, v in enumerate(row) if v == EMPTY]
    rng.shuffle(empties)
    for a in empties:
        cands = _reachable_empties(grid, a)
        if cands:
            b = rng.choice(cands)[0]
            v1, v2 = _pair_values(rng, False)
            grid[a[0]][a[1]] = v1
            grid[b[0]][b[1]] = v2
            return a, b
    return None
