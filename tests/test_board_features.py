"""Stage-1 board features: power-up tiles, collapsing rows, the "+" add button."""
from conftest import new_player

from engine import session as S
from engine.generator import LevelSpec, Level, generate_level
from engine.modes import spec_for
from engine.rules import (add_rows, apply_move_detailed, base, can_match, find_pairs, power, tiles_left,
                          validate_move)
from engine.solver import solve


def level(grid, frozen=()):
    return Level(grid=grid, frozen=list(frozen), seed=1, metrics={}, difficulty="EASY", difficulty_score=10, attempts=1)


def test_power_tiles_keep_their_number():
    assert base(105) == 5 and power(105) == 1 and power(207) == 2 and power(5) == 0
    assert can_match(105, 5) and can_match(207, 3) and not can_match(104, 3)


def test_bomb_clears_neighbours_and_chains():
    g = [[1, 2, 3], [4, 105, 6], [7, 8, 209]]
    d = apply_move_detailed(g, [], (1, 1), (0, 1))
    # bomb at (1,1) clears all 8 neighbours, including the row-clear at (2,2) which then fires too
    assert tiles_left(d["grid"]) == 0
    assert [t for t, _ in d["powers"]] == ["bomb", "row"]


def test_row_clear():
    g = [[3, 207, 4, 1], [5, 5, 2, 8]]
    d = apply_move_detailed(g, [], (0, 1), (1, 1))
    assert d["grid"][0] == [0, 0, 0, 0] and d["grid"][1] == [5, 0, 2, 8]


def test_empty_rows_collapse():
    g = [[3, 7, 0], [0, 0, 0], [4, 6, 1]]
    d = apply_move_detailed(g, [(2, 2)], (0, 0), (0, 1), collapse=True)
    assert d["grid"] == [[4, 6, 1]] and d["rows_removed"] == [0, 1] and d["frozen"] == [(0, 2)]
    # a fully cleared board is never collapsed to nothing
    d = apply_move_detailed([[3, 7]], [], (0, 0), (0, 1), collapse=True)
    assert d["grid"] == [[0, 0]]


def test_add_rows_copies_remaining_numbers_in_order():
    g, added = add_rows([[1, 0, 3], [0, 205, 0]])
    assert g == [[1, 0, 3], [0, 205, 1], [3, 5, 0]]    # power flag not copied
    assert added == [(1, 2), (2, 0), (2, 1)]
    assert add_rows([[1, 2]], max_rows=1) is None


def test_solver_understands_powers_and_collapse():
    assert solve([[1, 105, 3], [2, 5, 4]]).solvable is True        # odd-looking board cleared by a bomb
    assert solve([[3, 7], [0, 0], [4, 6]], collapse=True).solvable is True


def test_generator_places_powers():
    lvl = generate_level(LevelSpec(rows=6, cols=6, powers=2), 3)
    assert sum(1 for r in lvl.grid for v in r if power(v)) == 2
    assert all(v != 0 for r in lvl.grid for v in r)


def test_classic_stuck_asks_for_add_then_charges():
    st = S.new_state("classic", level([[1, 2, 3, 4]]))       # no pairs at all
    assert st["needs_add"] is False
    ev = S.play_move(st, (0, 0), (0, 1))                       # invalid - but board has no pairs
    info = S.add_info(st)
    assert info["free_left"] == 2 and info["cost"] == 0
    assert S.add_numbers(st)["success"] and S.add_numbers(st)["success"]
    assert S.add_info(st)["cost"] == S.ADD_COST
    assert S.add_numbers(st)["success"] is False                # needs paying
    assert S.add_numbers(st, paid=True)["success"]


def test_deadlock_sets_needs_add_in_classic():
    st = S.new_state("classic", level([[3, 7], [4, 5]]))
    ev = S.play_move(st, (0, 0), (0, 1))
    assert ev["valid"] and ev["rows_removed"] == [0] and st["grid"] == [[4, 5]]
    assert ev["deadlock"] == "add_needed" and st["needs_add"]
    assert S.play_move(st, (0, 0), (0, 1))["needs_add"]
    S.add_numbers(st)
    assert st["grid"] == [[4, 5], [4, 5]] and not st["needs_add"] and find_pairs(st["grid"], st["frozen"])


def test_zen_adds_automatically():
    st = S.new_state("zen", level([[3, 7, 1, 2]]))
    ev = S.play_move(st, (0, 0), (0, 1))
    assert ev["deadlock"] == "auto_added" and st["adds_used"] >= 1 and find_pairs(st["grid"], st["frozen"])


def test_daily_cannot_add():
    st = S.new_state("daily", level([[3, 7, 1, 2]]))
    ev = S.play_move(st, (0, 0), (0, 1))
    assert ev["deadlock"] == "final" and st["status"] == "finished"
    assert S.add_info(st)["cost"] is None


def test_last_single_tile_is_cleared():
    st = S.new_state("classic", level([[3, 7, 5]]))
    ev = S.play_move(st, (0, 0), (0, 1))
    assert ev.get("won") and ev["last_tile"] == [0, 2]


def test_add_endpoint_charges_coins(app):
    from models import User, db
    c = new_player(app)
    r = c.post("/api/games", json={"mode": "classic"}).get_json()
    gid, uid = r["game_id"], r["profile"]["id"]
    for _ in range(2):                                          # two free adds
        r = c.post(f"/api/games/{gid}/add").get_json()
        assert r["event"]["success"] and not r["event"].get("coins_spent")
    assert r["game"]["add"]["cost"] == 50

    def set_coins(n):
        with app.app_context():
            db.session.get(User, uid).coins = n
            db.session.commit()

    set_coins(10)
    r = c.post(f"/api/games/{gid}/add").get_json()
    assert r["event"]["success"] is False and r["event"]["needs_coins"] and r["profile"]["coins"] == 10
    set_coins(120)
    r = c.post(f"/api/games/{gid}/add").get_json()
    assert r["event"]["coins_spent"] == 50 and r["profile"]["coins"] == 70
