"""
AI hints and move explanations.

Hint level 1 - show a possible pair
Hint level 2 - explain why it works and what it opens up
Hint level 3 - the optimal move, verified by the solver
"""
from __future__ import annotations

from typing import Dict, Optional, Sequence

from .rules import WILD, Pos, apply_move, connection, find_pairs, label, match_reason, pair_key
from .solver import best_move

CONNECTION_TEXT = {
    "row": "they sit in the same row with nothing in between",
    "column": "they sit in the same column with nothing in between",
    "diagonal": "they share a clear diagonal",
    "wrap": "the row wraps - the end of one row connects to the start of the next",
}


def _new_options(grid, frozen, p1: Pos, p2: Pos):
    before = {pair_key(a, b) for a, b, _ in find_pairs(grid, frozen)}
    g2, f2 = apply_move(grid, frozen, p1, p2)
    after = {pair_key(a, b) for a, b, _ in find_pairs(g2, f2)}
    return before, after, after - before, g2, f2


def _easiest_pair(grid, frozen):
    """For a level-1 hint: the pair a human is most likely to have missed but can see - short distance first."""
    pairs = find_pairs(grid, frozen)
    if not pairs:
        return None
    def rank(p):
        (r1, c1), (r2, c2), kind = p
        dist = max(abs(r1 - r2), abs(c1 - c2))
        return (kind == "wrap", dist, grid[r1][c1] == WILD or grid[r2][c2] == WILD)
    return min(pairs, key=rank)


def explain_pair(grid, frozen, p1: Pos, p2: Pos) -> Dict:
    a, b = grid[p1[0]][p1[1]], grid[p2[0]][p2[1]]
    conn = connection(grid, p1, p2)
    before, after, unlocked, _, _ = _new_options(grid, frozen, p1, p2)
    lines = [f"Tiles {label(a)} and {label(b)} can be matched because {match_reason(a, b)}."]
    if conn:
        lines.append(f"They are connected: {CONNECTION_TEXT[conn]}.")
    if unlocked:
        n = len(unlocked)
        lines.append(f"This move also opens {n} additional matching possibilit{'y' if n == 1 else 'ies'}.")
    elif len(after) < len(before) - 1:
        lines.append("Careful - this move removes other options too.")
    return {"text": lines, "connection": conn, "unlocks": len(unlocked),
            "options_before": len(before), "options_after": len(after)}


def hint(grid, frozen, level: int, reuse_pair: Optional[Sequence[Pos]] = None, solver_budget: int = 6000) -> Optional[Dict]:
    frozen = [tuple(p) for p in frozen]
    level = max(1, min(3, int(level)))
    if level == 3:
        move, reason, res = best_move(grid, frozen, budget=solver_budget)
        if move is None:
            return None
        p1, p2 = move
        info = explain_pair(grid, frozen, p1, p2)
        if reason == "keeps_solvable":
            info["text"].append(f"Solver: this is the first step of a full clear ({res.moves_to_clear} moves).")
        else:
            info["text"].append("Solver: no guaranteed full clear found - this move keeps the most options open.")
        return {"level": 3, "pair": [list(p1), list(p2)], "title": "Optimal move", **info}

    if reuse_pair:
        p1, p2 = tuple(reuse_pair[0]), tuple(reuse_pair[1])
    else:
        found = _easiest_pair(grid, frozen)
        if not found:
            return None
        p1, p2, _ = found
    if level == 1:
        return {"level": 1, "pair": [list(p1), list(p2)], "title": "Try these two tiles.",
                "text": ["Try these two tiles."], "unlocks": None}
    return {"level": 2, "pair": [list(p1), list(p2)], "title": "Why this works", **explain_pair(grid, frozen, p1, p2)}


def explain_move(grid_before, frozen_before, p1: Pos, p2: Pos, conn: str,
                 streak_before: int, streak_after: int, chain: int = 0) -> Dict:
    """'Explain This Move' - returned with every successful match."""
    a, b = grid_before[p1[0]][p1[1]], grid_before[p2[0]][p2[1]]
    before, after, unlocked, _, _ = _new_options(grid_before, frozen_before, p1, p2)
    delta = len(after) - len(before)          # how the move changed the number of options
    return {
        "values": [label(a), label(b)],
        "rule": match_reason(a, b),
        "sum_to_10": a + b == 10 and WILD not in (a, b),
        "equal": a == b,
        "connection": conn,
        "same_row": p1[0] == p2[0],
        "same_column": p1[1] == p2[1],
        "diagonal": conn == "diagonal",
        "wrap": conn == "wrap",
        "distance": max(abs(p1[0] - p2[0]), abs(p1[1] - p2[1])),
        "options_before": len(before),
        "options_after": len(after),
        "unlocked": [[list(x), list(y)] for x, y in sorted(unlocked)],
        "difficulty_impact": delta,
        "streak": [streak_before, streak_after],
        "chain": chain,
    }
