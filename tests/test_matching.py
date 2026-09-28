"""Matching rules: equal numbers, sum-to-10, connections, blockers."""
from engine.rules import (BLOCKED, WILD, can_match, connection, find_pairs, parse_grid_text, validate_move)


def test_equal_numbers_match():
    assert can_match(5, 5)
    assert can_match(9, 9)


def test_sum_to_10_works():
    for a in range(1, 10):
        assert can_match(a, 10 - a)
    assert not can_match(3, 6)
    assert not can_match(4, 7)


def test_wildcard_matches_anything_but_empty():
    assert can_match(WILD, 3) and can_match(8, WILD) and can_match(WILD, WILD)
    assert not can_match(WILD, 0) and not can_match(WILD, BLOCKED)


def test_row_column_diagonal_connections():
    g = [[3, 0, 7],
         [0, 0, 0],
         [7, 0, 3]]
    assert connection(g, (0, 0), (0, 2)) == "row"
    assert connection(g, (0, 0), (2, 0)) == "column"
    assert connection(g, (0, 0), (2, 2)) == "diagonal"
    assert connection(g, (0, 2), (2, 0)) == "diagonal"


def test_path_must_be_clear():
    g = [[3, 1, 7]]
    assert connection(g, (0, 0), (0, 2)) is None
    ok, msg, _ = validate_move(g, [], (0, 0), (0, 2))
    assert not ok and "connected" in msg


def test_blocked_cell_blocks_path():
    g = [[5, BLOCKED, 5]]
    assert find_pairs(g) == []


def test_row_wrap_connects_end_of_row_to_next_start():
    g = [[1, 2, 4],
         [6, 8, 9]]
    assert connection(g, (0, 2), (1, 0)) == "wrap"
    assert ((0, 2), (1, 0), "wrap") in find_pairs(g)


def test_duplicate_matches_are_prevented():
    g = [[5, 5, 0], [0, 0, 0]]
    pairs = find_pairs(g)
    assert len(pairs) == 1                      # the pair is found once, not twice
    ok, _, _ = validate_move(g, [], (0, 0), (0, 0))
    assert not ok                               # a tile cannot match itself
    g2 = [[0, 5, 0]]
    ok, msg, _ = validate_move(g2, [], (0, 0), (0, 1))
    assert not ok and "empty" in msg            # an already-cleared tile cannot be reused


def test_frozen_tiles_cannot_be_matched():
    g = [[4, 4]]
    ok, msg, _ = validate_move(g, [(0, 1)], (0, 0), (0, 1))
    assert not ok and "frozen" in msg.lower()
    assert find_pairs(g, [(0, 1)]) == []


def test_parse_grid_text():
    g = parse_grid_text("1 9 .\n# * 5")
    assert g == [[1, 9, 0], [BLOCKED, WILD, 5]]
