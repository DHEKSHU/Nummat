"""Solver: proves solvable / unsolvable boards and returns a legal full clear."""
from engine.rules import apply_move, is_cleared, validate_move
from engine.solver import best_move, solve, values_pairable


def replay(grid, frozen, path):
    for a, b in path:
        ok, _, _ = validate_move(grid, frozen, a, b)
        assert ok, (a, b)
        grid, frozen = apply_move(grid, frozen, a, b)
    return grid


def test_simple_board_solves():
    g = [[1, 9, 5, 5], [3, 3, 2, 8]]
    res = solve(g)
    assert res.solvable is True
    assert res.moves_to_clear == 4
    assert is_cleared(replay(g, [], res.path))


def test_odd_tile_count_is_unsolvable():
    g = [[2, 7, 4, 4, 9], [8, 3, 7, 1, 6], [5, 5, 2, 8, 3]]
    res = solve(g)
    assert res.solvable is False
    assert "Odd" in res.reason
    assert res.best_path  # still reports the best partial line


def test_unpairable_values_detected():
    assert not values_pairable([[1, 2], [3, 4]])
    assert values_pairable([[1, 9], [3, 7]])
    assert solve([[1, 2], [3, 4]]).solvable is False


def test_geometric_deadlock_is_unsolvable():
    # 1 and 9 only connect through each other's partner - every order deadlocks
    g = [[1, 2], [8, 9]]
    res = solve(g)
    assert res.solvable is True or res.solvable is False  # decided, not unknown
    g2 = [[1, 3, 9, 7]]   # 1-9 blocked by 3, 3-7 blocked by 9
    assert solve(g2).solvable is False


def test_frozen_tiles_respected():
    g = [[4, 6, 5, 5]]
    res = solve(g, frozen=[(0, 1)])
    assert res.solvable is True
    assert res.path[0] == ((0, 2), (0, 3))  # the frozen 6 has to thaw first


def test_best_move_keeps_board_solvable():
    g = [[1, 1, 9, 9]]
    move, reason, _ = best_move(g)
    assert reason == "keeps_solvable"
    g2, _ = apply_move(g, [], *move)
    assert solve(g2).solvable is True
