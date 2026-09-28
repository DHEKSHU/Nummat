"""
Puzzle solver.

Depth-first search with
  * move ordering  - try the move that leaves the most options open first
                     (a "mobility" heuristic), wildcards last;
  * memoisation    - every board state proven to be a dead end is remembered,
                     so transpositions (the same board reached through a
                     different move order) are never searched twice;
  * a node budget  - keeps API calls fast; if the budget runs out the result
                     is reported as "unknown" instead of guessing.

Every move clears exactly two tiles, so any complete solution has exactly
tiles / 2 moves - the interesting questions are *whether* a full clear
exists and *which* moves keep it reachable.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence, Tuple

from .rules import WILD, Pos, apply_move, find_pairs, is_cleared, tiles_left

DEFAULT_BUDGET = 25_000


@dataclass
class SolveResult:
    solvable: Optional[bool]          # True / False / None (budget exhausted)
    path: List[Tuple[Pos, Pos]] = field(default_factory=list)
    nodes: int = 0
    moves_to_clear: int = 0
    branching: List[int] = field(default_factory=list)  # options available at each step of the path
    best_path: List[Tuple[Pos, Pos]] = field(default_factory=list)  # deepest line found (partial clear)
    reason: str = ""

    @property
    def status(self) -> str:
        return {True: "solvable", False: "unsolvable", None: "unknown"}[self.solvable]

    def to_dict(self) -> dict:
        return {
            "solvable": self.solvable,
            "status": self.status,
            "moves_to_clear": self.moves_to_clear,
            "nodes_searched": self.nodes,
            "path": [[list(a), list(b)] for a, b in self.path],
            "branching": self.branching,
            "best_path": [[list(a), list(b)] for a, b in self.best_path],
            "max_pairs_cleared": len(self.path) if self.solvable else len(self.best_path),
            "reason": self.reason,
        }


def values_pairable(grid) -> bool:
    """Cheap necessary condition: the remaining *values* can be perfectly paired.

    n pairs with n or with 10-n; 5 pairs only with 5; wildcards absorb odd ones.
    If this fails the state is a dead end no matter how the tiles are arranged.
    """
    counts = [0] * 12
    for row in grid:
        for v in row:
            if v > 0:
                counts[v] += 1
    odd = counts[5] % 2
    for n in range(1, 5):
        odd += (counts[n] + counts[10 - n]) % 2
    wild = counts[WILD]
    return odd <= wild and (wild - odd) % 2 == 0


def _state_key(grid: Sequence[Sequence[int]], frozen: Iterable[Pos]) -> tuple:
    return (tuple(v for row in grid for v in row), tuple(sorted(map(tuple, frozen))))


def _ordered_moves(grid, frozen):
    """Legal moves, best first: most follow-up options, then avoid spending wildcards."""
    pairs = find_pairs(grid, frozen)
    scored = []
    for p1, p2, _ in pairs:
        g2, f2 = apply_move(grid, frozen, p1, p2)
        mobility = len(find_pairs(g2, f2))
        uses_wild = (grid[p1[0]][p1[1]] == WILD) + (grid[p2[0]][p2[1]] == WILD)
        scored.append((-(mobility + (0 if not is_cleared(g2) else 1000)), uses_wild, p1, p2, g2, f2))
    scored.sort(key=lambda t: (t[0], t[1]))
    return pairs, scored


def solve(grid: Sequence[Sequence[int]], frozen: Iterable[Pos] = (), budget: int = DEFAULT_BUDGET) -> SolveResult:
    frozen = [tuple(p) for p in frozen]
    result = SolveResult(solvable=None, moves_to_clear=tiles_left(grid) // 2)
    if is_cleared(grid):
        result.solvable = True
        result.reason = "The board is already clear."
        return result
    n_tiles = tiles_left(grid)
    root_pairable = values_pairable(grid)
    if n_tiles % 2:
        result.reason = f"Odd number of tiles ({n_tiles}) - one tile can never be matched."
    elif not root_pairable:
        result.reason = "The numbers cannot all be paired (equal or sum-to-10), whatever the layout."

    dead: set = set()
    nodes = 0
    exhausted = False

    def dfs(g, f, path, branching) -> bool:
        nonlocal nodes, exhausted
        if len(path) > len(result.best_path):
            result.best_path = list(path)
        if is_cleared(g):
            result.path = list(path)
            result.branching = list(branching)
            return True
        key = _state_key(g, f)
        if key in dead:
            return False
        if root_pairable and not values_pairable(g):
            dead.add(key)
            return False
        nodes += 1
        if nodes > budget:
            exhausted = True
            return False
        pairs, ordered = _ordered_moves(g, f)
        for _, _, p1, p2, g2, f2 in ordered:
            path.append((p1, p2))
            branching.append(len(pairs))
            if dfs(g2, f2, path, branching):
                return True
            path.pop()
            branching.pop()
            if exhausted:
                return False
        dead.add(key)
        return False

    found = dfs([list(r) for r in grid], frozen, [], [])
    result.nodes = nodes
    if found:
        result.solvable = True
        result.reason = f"Full clear in {len(result.path)} moves."
    elif exhausted:
        result.solvable = None
        result.reason = result.reason or "Search budget exhausted before a full clear was found."
    else:
        result.solvable = False
        result.reason = result.reason or "Every line of play ends in a deadlock."
    return result


def best_move(grid, frozen=(), budget: int = 8_000):
    """The move a strong player would make now.

    Returns (move, reason) where reason is 'keeps_solvable' (first step of a
    verified full-clear line) or 'max_mobility' (no clear line found within
    budget; this move leaves the most options open).
    """
    res = solve(grid, frozen, budget=budget)
    if res.solvable and res.path:
        return res.path[0], "keeps_solvable", res
    pairs, ordered = _ordered_moves(grid, [tuple(p) for p in frozen])
    if not ordered:
        return None, "no_moves", res
    _, _, p1, p2, _, _ = ordered[0]
    return (p1, p2), "max_mobility", res


def random_playout(grid, frozen=(), rng: Optional[random.Random] = None, max_steps: int = 500):
    """Play uniformly random legal moves until stuck. Returns (cleared, depth)."""
    rng = rng or random.Random()
    g = [list(r) for r in grid]
    f = [tuple(p) for p in frozen]
    depth = 0
    while depth < max_steps:
        if is_cleared(g):
            return True, depth
        pairs = find_pairs(g, f)
        if not pairs:
            return False, depth
        p1, p2, _ = rng.choice(pairs)
        g, f = apply_move(g, f, p1, p2)
        depth += 1
    return is_cleared(g), depth
