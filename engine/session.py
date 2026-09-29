"""
GameSession - the game engine.

Operates on a plain JSON-serialisable `state` dict so it can be stored in the
database between requests (no global game state, many players at once).
No Flask imports: everything here is unit-testable.
"""
from __future__ import annotations

import json
import random
import time
from typing import Dict, List, Optional, Tuple

from . import hints as hint_engine
from .generator import Level, generate_level, inject_solvable_pair, seed_from
from .modes import MODES, ModeConfig
from .rules import (WILD, add_rows as rules_add_rows, base, find_pairs, is_cleared, pair_key, tiles_left,
                    validate_move)
from .solver import solve

MAX_HISTORY = 40
ITEM_IDS = ("shuffle", "smart_hint", "time_freeze", "streak_shield", "double_coins")
ADD_COST = 50          # coins for each "+" after the free ones
MAX_ROWS = 40


def _now() -> float:
    return time.time()


def new_state(mode: str, level: Level, *, pack: Optional[str] = None, level_index: Optional[int] = None,
              level_key: Optional[str] = None, par: Optional[int] = None, spec: Optional[Dict] = None,
              hints_override: Optional[int] = None, now: Optional[float] = None) -> Dict:
    cfg = MODES[mode]
    now = now or _now()
    hints = cfg.hints if hints_override is None or cfg.hints == 0 else hints_override
    return {
        "mode": mode,
        "pack": pack,
        "level_index": level_index,
        "level_key": level_key,
        "seed": level.seed,
        "spec": spec or {},
        "grid": [list(r) for r in level.grid],
        "frozen": [list(p) for p in level.frozen],
        "rows": len(level.grid),
        "cols": len(level.grid[0]),
        "pairs_total": tiles_left(level.grid) // 2,
        "difficulty": level.difficulty,
        "difficulty_score": level.difficulty_score,
        "metrics": level.metrics,
        "score": 0,
        "streak": 0,
        "max_streak": 0,
        "matches": 0,
        "moves": 0,                 # valid matches currently applied (undo decrements)
        "attempts": 0,              # every attempt, valid or not
        "mistakes": 0,
        "hints_left": hints,        # None = unlimited
        "hints_used": 0,
        "undos_left": cfg.undos,
        "undos_used": 0,
        "hint_pair": None,
        "chain": 0,
        "max_chain": 0,
        "last_unlocked": [],
        "deadlocks": 0,
        "injections": 0,
        "stuck": False,
        "boards_cleared": 0,
        "started_at": now,
        "deadline": now + cfg.time_limit if cfg.time_limit else None,
        "par_time": par,
        "move_limit": cfg.move_limit,
        "shield": False,
        "double_coins": False,
        "assisted": False,
        "items_used": [],
        "status": "active",         # active | won | finished | lost | abandoned
        "end_reason": None,
        "ended_at": None,
        "history": [],
        "last_explain": None,
        "adds_used": 0,
        "adds_free": cfg.adds_free,         # None = unlimited
        "collapse": cfg.collapse,
        "needs_add": False,                 # stuck: the player should tap "+"
        "rows_cleared": 0,
        "powers_fired": 0,
    }


def config(state: Dict) -> ModeConfig:
    return MODES[state["mode"]]


def elapsed(state: Dict, now: Optional[float] = None) -> float:
    end = state.get("ended_at") or now or _now()
    return max(0.0, end - state["started_at"])


def time_left(state: Dict, now: Optional[float] = None) -> Optional[float]:
    if not state.get("deadline"):
        return None
    return max(0.0, state["deadline"] - (now or _now()))


def public_view(state: Dict, now: Optional[float] = None) -> Dict:
    cfg = config(state)
    hidden = {"history", "hint_pair", "spec"}
    view = {k: v for k, v in state.items() if k not in hidden}
    view["time_left"] = time_left(state, now)
    view["elapsed"] = round(elapsed(state, now), 1)
    view["moves_used"] = state["attempts"]
    view["moves_remaining"] = (state["move_limit"] - state["attempts"]) if state.get("move_limit") else None
    view["can_undo"] = bool(state["history"]) and (state["undos_left"] is None or state["undos_left"] > 0)
    view["available_pairs"] = len(find_pairs(state["grid"], state["frozen"]))
    view["mode_config"] = cfg.to_dict()
    view["add"] = add_info(state)
    if not cfg.show_score:
        view["score"] = None
    return view


# ---------------------------------------------------------------------------
def _finish(state: Dict, status: str, reason: str, now: Optional[float] = None) -> None:
    if state["status"] != "active":
        return
    now = now or _now()
    state["status"] = status
    state["end_reason"] = reason
    state["ended_at"] = now
    if status == "won" or state["mode"] == "time_attack":
        state["score"] += _completion_bonus(state, now)


def _completion_bonus(state: Dict, now: float) -> int:
    if state["mode"] == "time_attack":
        return 25 * state["boards_cleared"]
    bonus = 100
    if state.get("par_time"):
        spent = elapsed(state, now)
        if spent < state["par_time"]:
            bonus += int((state["par_time"] - spent) * 2)
    if state["mode"] == "daily" and state.get("move_limit"):
        bonus += 15 * max(0, state["move_limit"] - state["attempts"])
    if state["mode"] == "expert":
        bonus += 150
    return bonus


def check_timeout(state: Dict, now: Optional[float] = None) -> bool:
    """Finish the game if its clock has run out. Returns True if it just ended."""
    if state["status"] != "active" or not state.get("deadline"):
        return False
    now = now or _now()
    if now >= state["deadline"]:
        _finish(state, "finished", "time_up", now=state["deadline"])
        return True
    return False


def _snapshot(state: Dict) -> Dict:
    keys = ("grid", "frozen", "score", "chain", "last_unlocked", "moves", "boards_cleared", "rows_cleared")
    return json.loads(json.dumps({k: state[k] for k in keys}))


def _points(state: Dict, a: int, b: int, conn: str, dist: int, chained: bool) -> int:
    a, b = base(a), base(b)
    pts = 10
    if state["streak"] >= 3:
        pts += min(50, 5 * (state["streak"] - 2))
    if a + b == 10 and WILD not in (a, b):
        pts += 5
    if conn == "wrap":
        pts += 4
    elif dist > 1:
        pts += min(6, 2 * (dist - 1))
    if chained:
        pts += 15 * min(state["chain"], 10)
    return pts


def _new_board(state: Dict) -> None:
    """Time Attack: replace a cleared board with a fresh one (deterministic from the game seed)."""
    from .generator import LevelSpec  # local import to avoid a cycle in type checkers
    spec = LevelSpec(**state["spec"]) if state.get("spec") else LevelSpec(rows=5, cols=5, max_attempts=3, rollouts=6)
    lvl = generate_level(spec, seed_from(state["seed"], "board", state["boards_cleared"]))
    state["grid"] = [list(r) for r in lvl.grid]
    state["frozen"] = [list(p) for p in lvl.frozen]
    state["rows"], state["cols"] = len(lvl.grid), len(lvl.grid[0])
    state["history"] = []
    state["last_unlocked"] = []


def play_move(state: Dict, p1, p2, now: Optional[float] = None) -> Dict:
    """Attempt a match. Returns an event dict describing what happened."""
    now = now or _now()
    cfg = config(state)
    if check_timeout(state, now):
        return {"success": False, "message": "Time's up!", "game_over": True}
    if state["status"] != "active":
        return {"success": False, "message": "This game is over.", "game_over": True}
    if state.get("stuck"):
        return {"success": False, "message": "Deadlock! Undo your last move or end the game.", "stuck": True}
    if state.get("needs_add"):
        return {"success": False, "message": "No moves left - tap ➕ to add numbers.", "needs_add": True}

    p1, p2 = tuple(p1), tuple(p2)
    grid, frozen = state["grid"], [tuple(p) for p in state["frozen"]]
    state["attempts"] += 1
    ok, message, conn = validate_move(grid, frozen, p1, p2)

    if not ok:
        state["mistakes"] += 1
        shielded = False
        if state.get("shield") and state["streak"] > 0:
            state["shield"] = False
            shielded = True
        else:
            state["streak"] = 0
        state["chain"] = 0
        event = {"success": False, "valid": False, "message": message, "shielded": shielded}
        if state.get("move_limit") and state["attempts"] >= state["move_limit"]:
            _finish(state, "finished", "out_of_moves", now)
            event["game_over"] = True
        return event

    # ---- valid move ----
    a, b = grid[p1[0]][p1[1]], grid[p2[0]][p2[1]]
    streak_before = state["streak"]
    chained = cfg.chain and pair_key(p1, p2) in {pair_key(tuple(x), tuple(y)) for x, y in state["last_unlocked"]}

    state["history"].append(_snapshot(state))
    state["history"] = state["history"][-MAX_HISTORY:]

    state["streak"] += 1
    state["max_streak"] = max(state["max_streak"], state["streak"])
    state["matches"] += 1
    state["moves"] += 1
    state["chain"] = state["chain"] + 1 if chained else (1 if cfg.chain else 0)
    state["max_chain"] = max(state["max_chain"], state["chain"])
    dist = max(abs(p1[0] - p2[0]), abs(p1[1] - p2[1]))
    points = _points(state, a, b, conn, dist, chained)

    collapse = state.get("collapse", False)
    explanation = hint_engine.explain_move(grid, frozen, p1, p2, conn, streak_before, state["streak"], state["chain"],
                                           collapse=collapse)
    outcome = explanation.pop("outcome")
    extra = explanation["extra_cleared"]
    if extra > 0:
        points += 20 * extra                       # power-ups: bonus per extra tile blasted
    if explanation["rows_removed"]:
        points += 25 * explanation["rows_removed"]  # cleared rows
    state["score"] += points
    state["grid"] = [list(r) for r in outcome["grid"]]
    state["frozen"] = [list(p) for p in outcome["frozen"]]
    state["rows_cleared"] = state.get("rows_cleared", 0) + explanation["rows_removed"]
    state["powers_fired"] = state.get("powers_fired", 0) + len(explanation["powers"])
    state["rows"] = len(state["grid"])
    state["last_unlocked"] = explanation["unlocked"]
    state["hint_pair"] = None
    state["needs_add"] = False
    explanation["points"] = points
    state["last_explain"] = explanation

    event = {"success": True, "valid": True, "points": points, "explain": explanation,
             "cleared": [list(p) for p in outcome["cleared"]], "rows_removed": list(outcome["rows_removed"]),
             "powers": explanation["powers"],
             "thawed": [list(p) for p in frozen if tuple(p) not in set(outcome["cleared"])
                        and [p[0] - sum(1 for x in outcome["rows_removed"] if x < p[0]), p[1]] not in state["frozen"]]}

    # a single tile left can never be matched - clear it as a bonus
    if tiles_left(state["grid"]) == 1:
        for r, row in enumerate(state["grid"]):
            for c, v in enumerate(row):
                if v > 0:
                    state["grid"][r][c] = 0
                    event["last_tile"] = [r, c]
        state["score"] += 30

    if is_cleared(state["grid"]):
        if cfg.endless:
            state["boards_cleared"] += 1
            state["score"] += 50
            _new_board(state)
            event["new_board"] = True
        else:
            _finish(state, "won", "cleared", now)
            event["game_over"] = True
            event["won"] = True
            return event
    elif not find_pairs(state["grid"], state["frozen"]):
        _handle_deadlock(state, event, now)
        if event.get("game_over"):
            return event

    if state.get("move_limit") and state["attempts"] >= state["move_limit"] and state["status"] == "active":
        _finish(state, "finished", "out_of_moves", now)
        event["game_over"] = True
    return event


# ---------------------------------------------------------------- "+" add --
def add_info(state: Dict) -> Dict:
    """What the "+" button can do right now (shown on the button)."""
    free = state.get("adds_free", 0)
    used = state.get("adds_used", 0)
    cfg = config(state)
    free_left = None if free is None else max(0, free - used)
    cost = 0 if (free is None or free_left > 0) else (ADD_COST if cfg.items_allowed else None)
    return {"free_left": free_left, "cost": cost, "used": used,
            "available": state["status"] == "active" and cost is not None and tiles_left(state["grid"]) > 0,
            "needed": bool(state.get("needs_add"))}


def add_numbers(state: Dict, paid: bool = False) -> Dict:
    """The "+" button: copy every remaining number onto the end of the board.

    The service layer checks and charges coins; pass paid=True once it has.
    """
    if state["status"] != "active":
        return {"success": False, "message": "This game is over."}
    info = add_info(state)
    if info["cost"] is None:
        return {"success": False, "message": "Adding numbers isn't allowed in this mode."}
    if info["cost"] and not paid:
        return {"success": False, "message": f"No free adds left - it costs {ADD_COST} coins.", "cost": info["cost"]}
    result = rules_add_rows(state["grid"], MAX_ROWS)
    if result is None:
        return {"success": False, "message": "The board is full - match some tiles first."}
    grid, added = result
    state["grid"] = grid
    state["rows"] = len(grid)
    state["adds_used"] = state.get("adds_used", 0) + 1
    state["pairs_total"] += len(added) // 2
    state["history"] = []              # an add can't be undone
    state["hint_pair"] = None
    state["stuck"] = False
    state["needs_add"] = False
    state["last_unlocked"] = []
    event = {"success": True, "added": [list(p) for p in added], "paid": bool(info["cost"]),
             "message": f"➕ {len(added)} numbers added"}
    if not find_pairs(state["grid"], state["frozen"]):
        _handle_deadlock(state, event, _now())
    return event


def _handle_deadlock(state: Dict, event: Dict, now: float) -> None:
    """No pair left on the board."""
    cfg = config(state)
    state["deadlocks"] += 1
    state["chain"] = 0
    info = add_info(state)
    if cfg.auto_add and info["cost"] == 0 and rules_add_rows(state["grid"], MAX_ROWS) is not None:
        auto = add_numbers(state)
        event["deadlock"] = "auto_added"
        event["added"] = auto.get("added", [])
        return
    if info["cost"] is not None and rules_add_rows(state["grid"], MAX_ROWS) is not None:
        state["needs_add"] = True
        event["deadlock"] = "add_needed"
        return
    if cfg.inject_on_deadlock and not cfg.move_limit:
        # board too tall to grow: drop in a guaranteed pair instead
        rng = random.Random(seed_from(state["seed"], "inject", state["matches"]))
        placed = inject_solvable_pair(state["grid"], rng)
        if placed is None:
            state["frozen"] = []
        state["injections"] += 1
        event["deadlock"] = "injected"
        event["injected"] = [list(p) for p in placed] if placed else []
        return
    if state["undos_left"] is None or state["undos_left"] > 0:
        state["stuck"] = True
        event["deadlock"] = "stuck"
    else:
        _finish(state, "lost" if state["mode"] == "expert" else "finished", "deadlock", now)
        event["deadlock"] = "final"
        event["game_over"] = True


def undo(state: Dict) -> Dict:
    if state["status"] != "active":
        return {"success": False, "message": "This game is over."}
    if not state["history"]:
        return {"success": False, "message": "No moves to undo."}
    if state["undos_left"] is not None and state["undos_left"] <= 0:
        return {"success": False, "message": "No undos left."}
    snap = state["history"].pop()
    for k, v in snap.items():
        state[k] = v
    if state["undos_left"] is not None:
        state["undos_left"] -= 1
    state["undos_used"] += 1
    state["streak"] = 0
    state["stuck"] = False
    state["needs_add"] = False
    state["rows"] = len(state["grid"])
    state["hint_pair"] = None
    return {"success": True}


def use_hint(state: Dict, level: int = 1, free: bool = False) -> Dict:
    """Level 1 costs a hint; level 2 explains the current hint for free; level 3 costs a hint."""
    if state["status"] != "active":
        return {"success": False, "message": "This game is over."}
    level = max(1, min(3, int(level)))
    reuse = state.get("hint_pair") if level == 2 else None
    cost = 0 if free or (level == 2 and reuse) else 1
    if cost and state["hints_left"] is not None and state["hints_left"] <= 0:
        msg = "Hints are disabled in this mode." if config(state).hints == 0 else "No hints remaining!"
        return {"success": False, "message": msg}
    h = hint_engine.hint(state["grid"], state["frozen"], level, reuse_pair=reuse, collapse=state.get("collapse", False))
    if not h:
        return {"success": False, "message": "No moves available right now."}
    if cost:
        if state["hints_left"] is not None:
            state["hints_left"] -= 1
        state["hints_used"] += 1
    state["hint_pair"] = h["pair"]
    h["success"] = True
    h["hints_left"] = state["hints_left"]
    h["cost"] = cost
    return h


def analyse(state: Dict, reveal: bool = False, budget: int = 20_000) -> Dict:
    """'Can this board be solved?' - optionally reveal the full solution."""
    res = solve(state["grid"], state["frozen"], budget=budget, collapse=state.get("collapse", False))
    if reveal and res.solvable:
        state["assisted"] = True
    out = res.to_dict()
    if not reveal:
        out["path"] = []
    return out


def use_item(state: Dict, item: str, now: Optional[float] = None) -> Dict:
    now = now or _now()
    if state["status"] != "active":
        return {"success": False, "message": "This game is over."}
    if not config(state).items_allowed:
        return {"success": False, "message": "Items are disabled in this mode."}
    if item == "shuffle":
        rng = random.Random(seed_from(state["seed"], "shuffle", state["attempts"], len(state["items_used"])))
        cells = [(r, c) for r, row in enumerate(state["grid"]) for c, v in enumerate(row) if v > 0]
        values = [state["grid"][r][c] for r, c in cells]
        for _ in range(30):
            rng.shuffle(values)
            for (r, c), v in zip(cells, values):
                state["grid"][r][c] = v
            if find_pairs(state["grid"], state["frozen"]):
                break
        state["assisted"] = True
        state["stuck"] = False
        state["needs_add"] = not find_pairs(state["grid"], state["frozen"]) and state.get("needs_add", False)
        result = {"success": True, "message": "Board shuffled! 🔀"}
    elif item == "smart_hint":
        result = use_hint(state, 3, free=True)
        if not result.get("success"):
            return result
        result["message"] = "Smart hint 💡"
    elif item == "time_freeze":
        if not state.get("deadline"):
            return {"success": False, "message": "No clock to freeze in this mode."}
        state["deadline"] += 15
        result = {"success": True, "message": "Time frozen: +15 s ⏱"}
    elif item == "streak_shield":
        state["shield"] = True
        result = {"success": True, "message": "Streak shield active 🔥 - your next mistake won't break the streak"}
    elif item == "double_coins":
        state["double_coins"] = True
        result = {"success": True, "message": "Double coins for this game ✨"}
    else:
        return {"success": False, "message": "Unknown item."}
    state["items_used"].append(item)
    return result


def abandon(state: Dict, now: Optional[float] = None) -> None:
    if state["status"] == "active":
        if state["mode"] == "time_attack" and state["matches"]:
            _finish(state, "finished", "ended", now)
        else:
            _finish(state, "abandoned", "abandoned", now)


def summary(state: Dict) -> Dict:
    """Compact record used by analytics, achievements and the adaptive engine."""
    return {
        "mode": state["mode"],
        "pack": state.get("pack"),
        "won": state["status"] == "won" or (state["mode"] == "time_attack" and state["boards_cleared"] > 0),
        "status": state["status"],
        "score": state["score"] or 0,
        "matches": state["matches"],
        "attempts": state["attempts"],
        "mistakes": state["mistakes"],
        "hints_used": state["hints_used"],
        "undos_used": state["undos_used"],
        "max_streak": state["max_streak"],
        "max_chain": state["max_chain"],
        "deadlocks": state["deadlocks"],
        "duration": round(elapsed(state), 2),
        "pairs": state["pairs_total"],
        "rows": state["rows"],
        "cols": state["cols"],
        "difficulty": state["difficulty"],
        "difficulty_score": state["difficulty_score"],
        "assisted": state["assisted"],
        "adds_used": state.get("adds_used", 0),
        "rows_cleared": state.get("rows_cleared", 0),
        "powers_fired": state.get("powers_fired", 0),
    }
