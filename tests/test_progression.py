"""Game sessions, adaptive difficulty and achievements."""
from engine import achievements, difficulty
from engine import session as S
from engine.generator import LevelSpec, generate_level
from engine.modes import spec_for
from engine.solver import best_move


def new(mode, seed=3, **kw):
    spec = spec_for(mode, 5.0)
    return S.new_state(mode, generate_level(spec, seed), spec=vars(spec), **kw)


def autoplay(st, n=200):
    for _ in range(n):
        if st["status"] != "active" or st.get("stuck"):
            break
        mv, _, _ = best_move(st["grid"], st["frozen"], budget=3000)
        if not mv:
            break
        S.play_move(st, *mv)
    return st


def test_classic_game_can_be_won_and_scores():
    st = autoplay(new("classic"))
    assert st["status"] == "won"
    assert st["score"] > 0 and st["mistakes"] == 0
    assert S.summary(st)["won"]


def test_invalid_move_breaks_streak_unless_shielded():
    st = new("classic")
    mv, _, _ = best_move(st["grid"], st["frozen"])
    S.play_move(st, *mv)
    assert st["streak"] == 1
    S.use_item(st, "streak_shield")
    empty = next((r, c) for r, row in enumerate(st["grid"]) for c, v in enumerate(row) if v == 0)
    S.play_move(st, empty, empty)
    assert st["streak"] == 1 and st["mistakes"] == 1       # shield absorbed it
    S.play_move(st, empty, empty)
    assert st["streak"] == 0


def test_undo_restores_board_and_counts():
    st = new("classic")
    before = [r[:] for r in st["grid"]]
    mv, _, _ = best_move(st["grid"], st["frozen"])
    S.play_move(st, *mv)
    assert S.undo(st)["success"]
    assert st["grid"] == before and st["undos_left"] == 2 and st["undos_used"] == 1


def test_daily_move_limit_counts_every_attempt():
    st = new("daily")
    empty = (0, 0)
    for _ in range(20):
        if st["status"] != "active":
            break
        S.play_move(st, empty, empty)
    assert st["status"] == "finished" and st["end_reason"] == "out_of_moves"
    assert S.use_hint(st, 1)["success"] is False


def test_time_attack_times_out():
    st = new("time_attack", now=1000.0)
    assert S.check_timeout(st, now=1000.0 + 121)
    assert st["status"] == "finished" and st["end_reason"] == "time_up"


def test_hint_levels():
    st = new("zen")
    h1 = S.use_hint(st, 1)
    h2 = S.use_hint(st, 2)
    assert h1["pair"] == h2["pair"] and h2["cost"] == 0   # "why" explains the same pair for free
    assert any("because" in t for t in h2["text"])
    h3 = S.use_hint(st, 3)
    assert h3["level"] == 3 and "Solver" in h3["text"][-1]


def test_explain_move_reports_rule_and_connection():
    st = new("classic")
    mv, _, _ = best_move(st["grid"], st["frozen"])
    ev = S.play_move(st, *mv)
    ex = ev["explain"]
    assert ex["connection"] in ("row", "column", "diagonal", "wrap")
    assert ex["streak"] == [0, 1]
    assert "options_before" in ex and "difficulty_impact" in ex


def test_skill_rises_with_strong_play_and_falls_with_weak():
    strong = [dict(attempts=20, mistakes=0, hints_used=0, undos_used=0, max_streak=20, deadlocks=0,
                   duration=40, pairs=20, won=True, difficulty_score=50)] * 8
    weak = [dict(attempts=30, mistakes=14, hints_used=3, undos_used=3, max_streak=2, deadlocks=2,
                 duration=300, pairs=12, won=False, difficulty_score=20)] * 8
    assert difficulty.skill_from_history(strong) > difficulty.PRIOR_SKILL + 3
    assert difficulty.skill_from_history(weak) < difficulty.PRIOR_SKILL


def test_recommendation_matches_spec_example():
    rec = difficulty.recommend(7.4)
    assert (rec["rows"], rec["cols"]) == (7, 8) and rec["pairs"] == 28 and rec["complexity"] == "HIGH"
    assert rec["hints"] == 1 and rec["time"] > 0


def test_achievements_trigger_correctly():
    ctx = {"event": "finish", "streak": 12, "stats": {"total_matches": 5},
           "game": {"won": True, "duration": 25, "mistakes": 0, "hints_used": 0, "undos_used": 0,
                    "assisted": False, "rows": 6, "cols": 6, "mode": "expert", "difficulty": "EXPERT",
                    "deadlocks": 0}, "unlocked": ["first_match"]}
    new_ids = set(achievements.evaluate(ctx))
    assert {"streak_5", "streak_10", "perfectionist", "speed_demon", "under_30", "lightning",
            "impossible_survived", "optimal_solver"} <= new_ids
    assert "first_match" not in new_ids and "streak_20" not in new_ids
