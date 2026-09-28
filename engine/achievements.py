"""
Achievements, grouped into categories.

Each achievement has a check(ctx) predicate. `ctx` is a flat dict assembled by
the service layer after every move and at the end of every game:

    event            "move" | "finish"
    streak           current streak
    game             finished-game summary (finish events only)
    stats            lifetime PlayerStats as a dict
    skill            current adaptive skill
    packs_complete   ids of fully completed packs
    packs_won        ids of packs with at least one level won
    unlocked         ids already unlocked
"""
from __future__ import annotations

from typing import Callable, Dict, List

CATEGORIES = ["Skill", "Speed", "Strategy", "Exploration", "Extreme"]


def _won(ctx) -> bool:
    g = ctx.get("game") or {}
    return ctx.get("event") == "finish" and bool(g.get("won"))


def _g(ctx) -> Dict:
    return ctx.get("game") or {}


ACHIEVEMENTS: List[Dict] = [
    # ---- Skill ----
    {"id": "first_match", "name": "First Match", "icon": "🏅", "category": "Skill", "reward": 10,
     "desc": "Make your first match", "check": lambda c: c["stats"].get("total_matches", 0) >= 1 or c.get("streak", 0) >= 1},
    {"id": "streak_5", "name": "Hot Streak", "icon": "🏅", "category": "Skill", "reward": 25,
     "desc": "Reach a 5 streak", "check": lambda c: c.get("streak", 0) >= 5},
    {"id": "streak_10", "name": "On Fire", "icon": "🏅", "category": "Skill", "reward": 50,
     "desc": "Reach a 10 streak", "check": lambda c: c.get("streak", 0) >= 10},
    {"id": "perfect_10", "name": "10 Perfect Matches", "icon": "🏅", "category": "Skill", "reward": 100,
     "desc": "Finish 10 games with 100% accuracy", "check": lambda c: c["stats"].get("perfect_games", 0) >= 10},
    {"id": "perfectionist", "name": "No-Mistake Run", "icon": "🏅", "category": "Skill", "reward": 75,
     "desc": "Clear a board with no mistakes, hints or undos",
     "check": lambda c: _won(c) and not _g(c).get("mistakes") and not _g(c).get("hints_used")
     and not _g(c).get("undos_used") and not _g(c).get("assisted")},
    # ---- Speed ----
    {"id": "speed_demon", "name": "Speed Demon", "icon": "⚡", "category": "Speed", "reward": 50,
     "desc": "Clear a board in under 2 minutes", "check": lambda c: _won(c) and _g(c).get("duration", 999) < 120},
    {"id": "lightning", "name": "Lightning", "icon": "⚡", "category": "Speed", "reward": 100,
     "desc": "Clear a 6×6 or larger board in under 60 seconds",
     "check": lambda c: _won(c) and _g(c).get("rows", 0) * _g(c).get("cols", 0) >= 36 and _g(c).get("duration", 999) < 60},
    {"id": "under_30", "name": "Under 30 Seconds", "icon": "⚡", "category": "Speed", "reward": 60,
     "desc": "Clear any board in under 30 seconds", "check": lambda c: _won(c) and _g(c).get("duration", 999) < 30},
    {"id": "rapid_fire", "name": "Rapid Fire", "icon": "⚡", "category": "Speed", "reward": 80,
     "desc": "Make 30 matches in one Time Attack run",
     "check": lambda c: c.get("event") == "finish" and _g(c).get("mode") == "time_attack" and _g(c).get("matches", 0) >= 30},
    # ---- Strategy ----
    {"id": "master_planner", "name": "Master Planner", "icon": "🧠", "category": "Strategy", "reward": 100,
     "desc": "Build a chain of 5 in Chain mode", "check": lambda c: c.get("chain", 0) >= 5 or _g(c).get("max_chain", 0) >= 5},
    {"id": "optimal_solver", "name": "Optimal Solver", "icon": "🧠", "category": "Strategy", "reward": 120,
     "desc": "Clear a HARD or EXPERT board with no hints, undos or deadlocks",
     "check": lambda c: _won(c) and _g(c).get("difficulty") in ("HARD", "EXPERT") and not _g(c).get("hints_used")
     and not _g(c).get("undos_used") and not _g(c).get("deadlocks") and not _g(c).get("assisted")},
    {"id": "deadlock_escape", "name": "Deadlock Escape", "icon": "🧠", "category": "Strategy", "reward": 60,
     "desc": "Hit a deadlock and still clear the board", "check": lambda c: _won(c) and _g(c).get("deadlocks", 0) >= 1},
    # ---- Exploration ----
    {"id": "explorer_autumn", "name": "Autumn Explorer", "icon": "🍂", "category": "Exploration", "reward": 40,
     "desc": "Clear a level in the Autumn pack", "check": lambda c: "autumn" in c.get("packs_won", ())},
    {"id": "explorer_spring", "name": "Spring Explorer", "icon": "🌸", "category": "Exploration", "reward": 40,
     "desc": "Clear a level in the Spring pack", "check": lambda c: "spring" in c.get("packs_won", ())},
    {"id": "explorer_summer", "name": "Summer Explorer", "icon": "☀️", "category": "Exploration", "reward": 40,
     "desc": "Clear a level in the Summer pack", "check": lambda c: "summer" in c.get("packs_won", ())},
    {"id": "explorer_winter", "name": "Winter Explorer", "icon": "❄️", "category": "Exploration", "reward": 40,
     "desc": "Clear a level in the Winter pack", "check": lambda c: "winter_event" in c.get("packs_won", ())},
    {"id": "daily_player", "name": "Daily Player", "icon": "📅", "category": "Exploration", "reward": 50,
     "desc": "Finish a Daily Challenge", "check": lambda c: c.get("event") == "finish" and _g(c).get("mode") == "daily"},
    {"id": "zen_garden", "name": "Zen Garden", "icon": "🧘", "category": "Exploration", "reward": 50,
     "desc": "Clear 5 Zen boards", "check": lambda c: c["stats"].get("zen_clears", 0) >= 5},
    {"id": "collector", "name": "Collector", "icon": "📦", "category": "Exploration", "reward": 200,
     "desc": "Complete every level in a pack", "check": lambda c: len(c.get("packs_complete", ())) >= 1},
    # ---- Extreme ----
    {"id": "impossible_survived", "name": "Impossible Survived", "icon": "💀", "category": "Extreme", "reward": 150,
     "desc": "Clear an Expert-mode board", "check": lambda c: _won(c) and _g(c).get("mode") == "expert"},
    {"id": "streak_20", "name": "Unstoppable", "icon": "🔥", "category": "Extreme", "reward": 100,
     "desc": "Reach a 20 streak", "check": lambda c: c.get("streak", 0) >= 20},
    {"id": "streak_50", "name": "50 Streak", "icon": "🔥", "category": "Extreme", "reward": 300,
     "desc": "Reach a 50 streak", "check": lambda c: c.get("streak", 0) >= 50},
    {"id": "master", "name": "Master of NUMMAT", "icon": "👑", "category": "Extreme", "reward": 500,
     "desc": "Reach skill 9.0 or complete every pack",
     "check": lambda c: c.get("skill", 0) >= 9.0 or len(c.get("packs_complete", ())) >= 6},
]
BY_ID: Dict[str, Dict] = {a["id"]: a for a in ACHIEVEMENTS}


def public(a: Dict) -> Dict:
    return {k: v for k, v in a.items() if k != "check"}


def evaluate(ctx: Dict) -> List[str]:
    """Return ids of achievements newly satisfied by ctx."""
    unlocked = set(ctx.get("unlocked", ()))
    ctx.setdefault("stats", {})
    new = []
    for a in ACHIEVEMENTS:
        if a["id"] in unlocked:
            continue
        try:
            if a["check"](ctx):
                new.append(a["id"])
        except (KeyError, TypeError):
            continue
    return new
