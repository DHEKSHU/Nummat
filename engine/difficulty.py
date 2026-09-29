"""
Adaptive Difficulty Engine
==========================

NUMMAT watches how you play and tunes the next board to you.

    recent games ──► per-game performance ──► skill (0-10, smoothed) ──► next-level parameters

Per game we measure accuracy, speed (seconds per pair), independence (hint and
undo usage), streak quality, stability (deadlocks) and completion. That gives
a performance value in [0, 1]. Performance on a *harder* board is worth more,
so the per-game skill is

    game_skill = 10 * performance * (0.6 + 0.4 * challenge)

where `challenge` comes from the generator's difficulty score. The player's
skill is an exponential moving average of game_skill, so one bad game nudges
the difficulty down a little and a run of strong games pushes it up.

An optional learned model (engine.predictor) can be blended in once enough
games have been recorded.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

PRIOR_SKILL = 3.0      # new players start here
EMA_ALPHA = 0.3        # weight of the newest game
WINDOW = 15            # games considered


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def game_components(g: Dict) -> Dict[str, float]:
    """Normalised 0..1 components for a single finished game summary.

    Expected keys: attempts, mistakes, hints_used, undos_used, max_streak,
    deadlocks, duration, pairs, won, difficulty_score.
    """
    attempts = max(1, g.get("attempts", 0))
    valid = attempts - g.get("mistakes", 0)
    pairs = max(1, g.get("pairs", 1))
    matches = max(1, valid)
    sec_per_pair = g.get("duration", 0) / matches
    return {
        "accuracy": _clamp(valid / attempts),
        "speed": _clamp((10.0 - sec_per_pair) / 8.0),
        "independence": _clamp(1 - 0.35 * g.get("hints_used", 0) - 0.2 * g.get("undos_used", 0)),
        "streak": _clamp(g.get("max_streak", 0) / max(4.0, pairs * 0.6)),
        "stability": _clamp(1 - 0.35 * g.get("deadlocks", 0)),
        "completion": 1.0 if g.get("won") else 0.3,
    }


WEIGHTS = {"accuracy": 0.28, "speed": 0.20, "independence": 0.14,
           "streak": 0.12, "stability": 0.10, "completion": 0.16}


def game_skill(g: Dict) -> float:
    comp = game_components(g)
    perf = sum(WEIGHTS[k] * comp[k] for k in WEIGHTS)
    challenge = _clamp(g.get("difficulty_score", 30) / 60.0)
    return round(10 * perf * (0.6 + 0.4 * challenge), 2)


def skill_from_history(games: Sequence[Dict], prior: float = PRIOR_SKILL,
                       model_prediction: Optional[float] = None) -> float:
    """EMA over the most recent WINDOW games (oldest first)."""
    skill = prior
    for g in list(games)[-WINDOW:]:
        skill = (1 - EMA_ALPHA) * skill + EMA_ALPHA * game_skill(g)
    if model_prediction is not None:
        skill = 0.7 * skill + 0.3 * model_prediction
    return round(_clamp(skill, 0, 10), 1)


def performance_report(games: Sequence[Dict]) -> Dict:
    """The 'Player performance' panel."""
    recent = list(games)[-WINDOW:]
    if not recent:
        return {"games": 0, "accuracy": None, "avg_solve": None, "hints": 0, "undos": 0,
                "best_streak": 0, "deadlocks": 0}
    attempts = sum(g.get("attempts", 0) for g in recent) or 1
    mistakes = sum(g.get("mistakes", 0) for g in recent)
    won = [g for g in recent if g.get("won")]
    return {
        "games": len(recent),
        "accuracy": round(100 * (attempts - mistakes) / attempts),
        "avg_solve": round(sum(g.get("duration", 0) for g in won) / len(won), 1) if won else None,
        "hints": sum(g.get("hints_used", 0) for g in recent),
        "undos": sum(g.get("undos_used", 0) for g in recent),
        "best_streak": max(g.get("max_streak", 0) for g in recent),
        "deadlocks": sum(g.get("deadlocks", 0) for g in recent),
        "win_rate": round(100 * len(won) / len(recent)),
    }


def trend(games: Sequence[Dict]) -> str:
    """'up', 'down' or 'steady' - compares the last 3 games with the 3 before."""
    g = list(games)
    if len(g) < 4:
        return "steady"
    last = sum(game_skill(x) for x in g[-3:]) / 3
    prev = sum(game_skill(x) for x in g[-6:-3]) / max(1, len(g[-6:-3]))
    if last - prev > 0.6:
        return "up"
    if prev - last > 0.6:
        return "down"
    return "steady"


def recommend(skill: float) -> Dict:
    """Next-level parameters for a given skill."""
    size = int(max(4, min(8, 4 + round(skill * 0.42))))
    rows, cols = (size, size) if size % 2 == 0 else (size, size + 1)   # full boards need an even cell count
    blocked = 2 if skill >= 8 else 0
    fill = 1.0
    pairs = (rows * cols - blocked) // 2
    tier = "EASY" if skill < 3 else "MEDIUM" if skill < 5.5 else "HARD" if skill < 8 else "EXPERT"
    complexity = {"EASY": "LOW", "MEDIUM": "MEDIUM", "HARD": "HIGH", "EXPERT": "EXTREME"}[tier]
    per_pair = max(2.5, 6.3 - 0.35 * skill)
    return {
        "skill": round(skill, 1),
        "grid": size,
        "rows": rows,
        "cols": cols,
        "fill": fill,
        "pairs": pairs,
        "tier": tier,
        "complexity": complexity,
        "time": int(round(pairs * per_pair / 5.0) * 5),
        "hints": 3 if skill < 4 else 2 if skill < 7 else 1,
        "frozen": size // 3 if skill >= 6 else 0,
        "blocked": blocked,
        "powers": 0 if size < 6 else (1 if size < 8 else 2),
    }


def explain_adjustment(games: Sequence[Dict], skill: float) -> List[str]:
    """Human-readable reasons behind the recommendation."""
    rep = performance_report(games)
    if not rep["games"]:
        return ["No games yet - starting you on a gentle board."]
    out = []
    if rep["accuracy"] is not None:
        out.append(f"Accuracy {rep['accuracy']}% " + ("✓ strong" if rep["accuracy"] >= 85 else "- room to improve"))
    if rep["hints"] == 0:
        out.append("No hints used - more complexity unlocked")
    elif rep["hints"] > rep["games"]:
        out.append("Frequent hints - keeping boards approachable")
    if rep["deadlocks"]:
        out.append(f"{rep['deadlocks']} deadlock(s) recently - fewer traps next")
    t = trend(games)
    out.append({"up": "Trend ↑ - difficulty increases", "down": "Trend ↓ - difficulty eases off",
                "steady": "Trend → - holding steady"}[t])
    return out
