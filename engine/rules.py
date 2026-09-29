"""
Core matching rules for NUMMAT.

Cell values
-----------
    0   empty (already cleared)
   -1   blocked cell  - a permanent wall; never matchable, blocks every path
  1-9   number tiles
   11   wildcard / rainbow (★) - matches any number tile
 +100   power-up flag on a number tile (value % 100 is the number):
        1xx 💣 bomb       - when matched, also clears the 8 surrounding tiles
        2xx ➖ row-clear  - when matched, also clears its whole row

Two tiles can be matched when
  * the values are equal, or sum to 10 (or one of them is a wildcard), and
  * they are connected by a clear line: same row, same column, a diagonal,
    or "row wrap" (the last tile of one row and the next tile in reading
    order), with only empty cells in between.

Frozen tiles (Expert / Winter) cannot be selected until a neighbouring tile
(up / down / left / right) is cleared.

Everything here is pure Python with no Flask dependency so it can be unit
tested and reused by the solver, the generator and the API.
"""
from __future__ import annotations

from typing import Iterable, Iterator, List, Optional, Sequence, Set, Tuple

EMPTY = 0
BLOCKED = -1
WILD = 11
BOMB = 1          # power codes (value // 100)
ROW_CLEAR = 2
POWER_NAMES = {BOMB: "bomb", ROW_CLEAR: "row"}
POWER_ICONS = {BOMB: "💣", ROW_CLEAR: "➖"}

Pos = Tuple[int, int]
Grid = List[List[int]]
Move = Tuple[Pos, Pos]

# Forward directions only: every unordered pair is discovered exactly once by
# scanning from the tile that comes first in reading order.
FORWARD_DIRECTIONS = (
    ((0, 1), "row"),
    ((1, 0), "column"),
    ((1, 1), "diagonal"),
    ((1, -1), "diagonal"),
)
ALL_DIRECTIONS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def is_tile(v: int) -> bool:
    return v > 0


def base(v: int) -> int:
    """The number on a tile, without any power-up flag."""
    return v % 100 if v > 0 else v


def power(v: int) -> int:
    """0 = plain tile, 1 = bomb, 2 = row-clear."""
    return v // 100 if v > 0 else 0


def label(v: int) -> str:
    v = base(v)
    if v == WILD:
        return "★"
    if v == BLOCKED:
        return "■"
    return str(v) if v else "·"


def can_match(a: int, b: int) -> bool:
    """Value rule: equal numbers, numbers that sum to 10, or a wildcard."""
    if a <= 0 or b <= 0:
        return False
    a, b = base(a), base(b)
    if a == WILD or b == WILD:
        return True
    return a == b or a + b == 10


def match_reason(a: int, b: int) -> str:
    """Short human explanation of *why* two values match."""
    a, b = base(a), base(b)
    if a == WILD or b == WILD:
        other = b if a == WILD else a
        return f"★ is a wildcard and matches {label(other)}"
    if a == b and a + b == 10:
        return f"{a} = {b} and {a} + {b} = 10"
    if a == b:
        return f"{a} = {b} (equal numbers)"
    if a + b == 10:
        return f"{a} + {b} = 10"
    return f"{a} and {b} do not match"


def is_cleared(grid: Sequence[Sequence[int]]) -> bool:
    return all(v <= 0 for row in grid for v in row)


def tiles_left(grid: Sequence[Sequence[int]]) -> int:
    return sum(1 for row in grid for v in row if v > 0)


def copy_grid(grid: Sequence[Sequence[int]]) -> Grid:
    return [list(r) for r in grid]


def reading_order(p: Pos, cols: int) -> int:
    return p[0] * cols + p[1]


def forward_neighbours(grid: Sequence[Sequence[int]], r: int, c: int) -> Iterator[Tuple[int, int, str]]:
    """Yield (row, col, connection) for every tile reachable *forward* from (r, c).

    Because a path must be clear, only the first non-empty cell in each
    direction can ever be a partner - that keeps pair detection O(cells * size)
    instead of O(cells^2 * size).
    """
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    for (dr, dc), kind in FORWARD_DIRECTIONS:
        rr, cc = r + dr, c + dc
        while 0 <= rr < rows and 0 <= cc < cols:
            v = grid[rr][cc]
            if v != EMPTY:
                if v > 0:
                    yield rr, cc, kind
                break
            rr += dr
            cc += dc
    # Row wrap: next tile in reading order, when it sits on a later row.
    idx = r * cols + c + 1
    total = rows * cols
    while idx < total:
        rr, cc = divmod(idx, cols)
        v = grid[rr][cc]
        if v != EMPTY:
            if v > 0 and rr != r:
                yield rr, cc, "wrap"
            break
        idx += 1


def connection(grid: Sequence[Sequence[int]], p1: Pos, p2: Pos) -> Optional[str]:
    """Return how p1 and p2 are connected ('row', 'column', 'diagonal', 'wrap') or None."""
    if p1 == p2:
        return None
    cols = len(grid[0])
    a, b = (p1, p2) if reading_order(p1, cols) < reading_order(p2, cols) else (p2, p1)
    for rr, cc, kind in forward_neighbours(grid, a[0], a[1]):
        if (rr, cc) == b:
            return kind
    return None


def find_pairs(grid: Sequence[Sequence[int]], frozen: Iterable[Pos] = ()) -> List[Tuple[Pos, Pos, str]]:
    """All currently legal moves as (pos1, pos2, connection)."""
    frozen_set: Set[Pos] = set(map(tuple, frozen)) if frozen else set()
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    out: List[Tuple[Pos, Pos, str]] = []
    seen = set()
    for r in range(rows):
        for c in range(cols):
            v = grid[r][c]
            if v <= 0 or (r, c) in frozen_set:
                continue
            for rr, cc, kind in forward_neighbours(grid, r, c):
                if (rr, cc) in frozen_set:
                    continue
                if can_match(v, grid[rr][cc]):
                    key = ((r, c), (rr, cc))
                    if key not in seen:  # wrap can coincide with row/col on edge cases
                        seen.add(key)
                        out.append(((r, c), (rr, cc), kind))
    return out


def pair_key(p1: Pos, p2: Pos) -> Tuple[Pos, Pos]:
    """Order-independent identifier for a pair."""
    a, b = tuple(p1), tuple(p2)
    return (a, b) if a <= b else (b, a)


def thaw_neighbours(frozen: Iterable[Pos], cleared: Iterable[Pos], rows: int, cols: int) -> List[Pos]:
    """Remove from `frozen` any tile orthogonally adjacent to a cleared cell."""
    frozen_set = set(map(tuple, frozen))
    for (r, c) in cleared:
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            frozen_set.discard((r + dr, c + dc))
    return sorted(frozen_set)


def collapse_rows(grid: Grid, frozen: Iterable[Pos]):
    """Remove rows that are completely empty (classic Number Match).

    Returns (grid, frozen, removed_row_indices). Never removes every row.
    """
    removed = [r for r, row in enumerate(grid) if all(v == EMPTY for v in row)]
    if not removed or len(removed) == len(grid):
        return grid, sorted(map(tuple, frozen)), []
    keep = [row for r, row in enumerate(grid) if r not in set(removed)]
    shift = lambda r: r - sum(1 for x in removed if x < r)
    new_frozen = sorted((shift(r), c) for (r, c) in frozen if r not in set(removed))
    return keep, new_frozen, removed


def remap_row(r: int, removed: Sequence[int]) -> int:
    return r - sum(1 for x in removed if x < r)


def apply_move_detailed(grid, frozen, p1: Pos, p2: Pos, collapse: bool = False) -> dict:
    """Clear p1 and p2, fire any power-ups (chain reactions included), thaw
    neighbours and optionally collapse empty rows.

    Returns {grid, frozen, cleared, powers, rows_removed}; `cleared` and
    `powers` use coordinates from *before* rows were collapsed.
    """
    g = copy_grid(grid)
    rows, cols = len(g), len(g[0])
    cleared: List[Pos] = []
    fired: List[Tuple[str, Pos]] = []
    queue = [tuple(p1), tuple(p2)]
    while queue:
        r, c = queue.pop(0)
        v = g[r][c]
        if v <= 0:
            continue
        g[r][c] = EMPTY
        cleared.append((r, c))
        pw = power(v)
        if pw == BOMB:
            fired.append(("bomb", (r, c)))
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    rr, cc = r + dr, c + dc
                    if (dr or dc) and 0 <= rr < rows and 0 <= cc < cols and g[rr][cc] > 0:
                        queue.append((rr, cc))
        elif pw == ROW_CLEAR:
            fired.append(("row", (r, c)))
            queue.extend((r, cc) for cc in range(cols) if g[r][cc] > 0)
    new_frozen = thaw_neighbours([p for p in frozen if tuple(p) not in set(cleared)], cleared, rows, cols)
    removed: List[int] = []
    if collapse:
        g, new_frozen, removed = collapse_rows(g, new_frozen)
    return {"grid": g, "frozen": [tuple(p) for p in new_frozen], "cleared": cleared,
            "powers": fired, "rows_removed": removed}


def apply_move(grid: Sequence[Sequence[int]], frozen: Iterable[Pos], p1: Pos, p2: Pos,
               collapse: bool = False) -> Tuple[Grid, List[Pos]]:
    """Return a *new* (grid, frozen) after the move (no validation)."""
    d = apply_move_detailed(grid, list(frozen), p1, p2, collapse)
    return d["grid"], d["frozen"]


def add_rows(grid, max_rows: int = 40) -> Optional[Tuple[Grid, List[Pos]]]:
    """Classic "+" rule: copy every remaining number (reading order, power-ups
    stripped) onto the end of the board, continuing after the last tile.

    Returns (new_grid, positions_added) or None if the board would get too tall.
    """
    cols = len(grid[0])
    values = [base(v) for row in grid for v in row if v > 0]
    if not values:
        return None
    g = copy_grid(grid)
    last = max(r * cols + c for r, row in enumerate(g) for c, v in enumerate(row) if v != EMPTY)
    idx, added = last + 1, []
    for v in values:
        while True:
            r, c = divmod(idx, cols)
            if r >= len(g):
                if len(g) >= max_rows:
                    return None
                g.append([EMPTY] * cols)
            if g[r][c] == EMPTY:
                break
            idx += 1
        g[r][c] = v
        added.append((r, c))
        idx += 1
    return g, added


def validate_move(grid: Sequence[Sequence[int]], frozen: Iterable[Pos], p1: Pos, p2: Pos) -> Tuple[bool, str, Optional[str]]:
    """Check a proposed move. Returns (ok, message, connection)."""
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    for (r, c) in (p1, p2):
        if not (0 <= r < rows and 0 <= c < cols):
            return False, "Move out of bounds.", None
    p1, p2 = tuple(p1), tuple(p2)
    if p1 == p2:
        return False, "Pick two different tiles.", None
    a, b = grid[p1[0]][p1[1]], grid[p2[0]][p2[1]]
    if a <= 0 or b <= 0:
        return False, "Selected an empty or blocked cell.", None
    frozen_set = set(map(tuple, frozen))
    if p1 in frozen_set or p2 in frozen_set:
        return False, "That tile is frozen - clear a neighbour to thaw it.", None
    if not can_match(a, b):
        return False, f"{label(a)} and {label(b)} are neither equal nor sum to 10.", None
    conn = connection(grid, p1, p2)
    if conn is None:
        return False, "Those tiles are not connected by a clear line.", None
    return True, "ok", conn


def grid_to_text(grid: Sequence[Sequence[int]]) -> str:
    return "\n".join("  ".join(label(v) for v in row) for row in grid)


def parse_grid_text(text: str) -> Grid:
    """Parse a board typed by a user (for the solver lab).

    Accepts digits 1-9, 0 / . / _ for empty, # or X for blocked, * or ★ for wild.
    Rows are separated by newlines; cells by spaces, commas or nothing.
    """
    mapping = {".": EMPTY, "_": EMPTY, "0": EMPTY, "#": BLOCKED, "X": BLOCKED, "x": BLOCKED,
               "■": BLOCKED, "*": WILD, "★": WILD, "W": WILD, "w": WILD}
    rows: Grid = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        tokens = line.replace(",", " ").split()
        if len(tokens) == 1 and len(tokens[0]) > 1:
            tokens = list(tokens[0])
        row = []
        for t in tokens:
            if t in mapping:
                row.append(mapping[t])
            elif t.isdigit() and 1 <= int(t) <= 9:
                row.append(int(t))
            else:
                raise ValueError(f"Unrecognised cell '{t}'")
        rows.append(row)
    if not rows:
        raise ValueError("Board is empty")
    width = len(rows[0])
    if any(len(r) != width for r in rows):
        raise ValueError("All rows must have the same number of cells")
    if len(rows) > 12 or width > 12:
        raise ValueError("Boards are limited to 12 x 12")
    return rows
