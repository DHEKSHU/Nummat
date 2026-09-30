"""
Game modes and the level-pack catalogue.

Each mode is a small configuration object; the GameSession reads it to decide
how timers, limits, deadlocks, hints and scoring behave. `spec_for()` turns a
mode (+ player skill, + optional pack/level) into a LevelSpec for the
generator.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, Optional

from .generator import TIERS, LevelSpec


@dataclass(frozen=True)
class ModeConfig:
    id: str
    name: str
    icon: str
    tagline: str
    description: str
    hints: Optional[int]          # None = unlimited
    undos: Optional[int]          # None = unlimited
    time_limit: Optional[int] = None   # seconds, whole game
    move_limit: Optional[int] = None   # every attempt counts (valid or not)
    inject_on_deadlock: bool = True    # False = a deadlock ends the game (unless you undo)
    endless: bool = False              # a cleared board is replaced by a new one
    chain: bool = False                # chain scoring
    show_score: bool = True
    items_allowed: bool = True
    solver_allowed: bool = True
    ranked: bool = True                # counts toward leaderboards

    def to_dict(self) -> Dict:
        return asdict(self)


MODES: Dict[str, ModeConfig] = {
    "classic": ModeConfig(
        "classic", "Classic", "🎯", "The original.",
        "Match equal numbers (5 ↔ 5) or numbers that add to 10 (3 + 7). Clear the board.",
        hints=3, undos=3),
    "chain": ModeConfig(
        "chain", "Chain", "🔗", "Think several moves ahead.",
        "Every match can open new lines. Play a pair your last match unlocked to grow the chain "
        "and multiply your score.",
        hints=2, undos=2, chain=True),
    "time_attack": ModeConfig(
        "time_attack", "Time Attack", "⏱️", "02:00 on the clock.",
        "Find as many matches as possible in two minutes. Cleared boards are replaced instantly.",
        hints=1, undos=0, time_limit=120, endless=True, solver_allowed=False),
    "daily": ModeConfig(
        "daily", "Daily Challenge", "📅", "Same puzzle for everyone.",
        "One seeded board per day. 20 moves - every attempt counts. No hints, no items, global scoreboard.",
        hints=0, undos=0, move_limit=20, inject_on_deadlock=False, items_allowed=False,
        solver_allowed=False),
    "zen": ModeConfig(
        "zen", "Zen", "🧘", "No timer. No pressure.",
        "No timer, no score, unlimited undo and hints. Just solve.",
        hints=None, undos=None, show_score=False, ranked=False),
    "expert": ModeConfig(
        "expert", "Expert", "💀", "Walls, ice and wildcards.",
        "Blocked cells, frozen tiles, wildcards, one undo, one hint. A deadlock ends the run.",
        hints=1, undos=1, inject_on_deadlock=False),
}


PACKS = [
    {"id": "default", "title": "Classic", "theme": "classic", "total_levels": 30,
     "special": None, "blurb": "Pure number matching."},
    {"id": "winter_event", "title": "Winter", "theme": "winter", "total_levels": 15,
     "special": "frozen", "blurb": "Frozen tiles thaw when a neighbour is cleared."},
    {"id": "autumn", "title": "Autumn", "theme": "autumn", "total_levels": 12,
     "special": "blocked", "blurb": "Fallen leaves block paths."},
    {"id": "spring", "title": "Spring", "theme": "spring", "total_levels": 12,
     "special": "wild", "blurb": "Blossom wildcards match anything."},
    {"id": "summer", "title": "Summer", "theme": "summer", "total_levels": 15,
     "special": "par", "blurb": "Bigger, brighter boards - beat the par time."},
    {"id": "challenge", "title": "Challenge", "theme": "classic", "total_levels": 20,
     "special": "mixed", "blurb": "Everything at once."},
]
PACK_BY_ID = {p["id"]: p for p in PACKS}
PACK_UNLOCK_REQUIREMENT = 10   # levels of the previous pack needed to unlock the next


def pack_level_size(index: int) -> int:
    """4 for the first levels, growing one step every 4 levels, capped at 8."""
    return min(4 + (index - 1) // 4, 8)


def board_dims(size: int) -> tuple:
    """Rows x cols for a board 'size'. Odd squares (5x5, 7x7) have an odd number of
    cells, which can never be completely filled with pairs, so they get one extra
    column: 5 -> 5x6, 7 -> 7x8. Even sizes stay square."""
    return (size, size) if size % 2 == 0 else (size, size + 1)


def pack_level_tier(index: int, total: int, skill: float) -> str:
    base = min(3, int(3 * (index - 1) / max(1, total - 1) + 0.25))   # EASY ... HARD across the pack
    nudge = max(-1, min(1, round((skill - 5.0) / 3.0)))               # adaptive: +-1 tier
    return TIERS[max(0, min(3, base + nudge))]


def spec_for(mode: str, skill: float, pack: Optional[str] = None, level_index: Optional[int] = None,
             recommendation: Optional[Dict] = None) -> LevelSpec:
    """Build the generator spec for a game."""
    if mode == "classic" and pack and level_index:
        p = PACK_BY_ID.get(pack, PACKS[0])
        size = pack_level_size(level_index)
        rows, cols = board_dims(size)
        spec = LevelSpec(rows=rows, cols=cols, fill=1.0,
                         target=pack_level_tier(level_index, p["total_levels"], skill))
        special = p["special"]
        if special == "frozen" or (special == "mixed" and level_index % 3 == 1):
            spec.frozen = max(2, size // 2)
        if special == "blocked" or (special == "mixed" and level_index % 3 == 2):
            spec.blocked = max(2, size // 2)
        if special == "wild" or (special == "mixed" and level_index % 3 == 0):
            spec.wild = 1 + (size >= 6)
        return spec

    if mode == "classic":           # adaptive quick play
        rec = recommendation or {}
        rows, cols = board_dims(rec.get("grid", 5))
        return LevelSpec(rows=rows, cols=cols, fill=1.0, target=rec.get("tier", "MEDIUM"),
                         frozen=rec.get("frozen", 0), blocked=rec.get("blocked", 0))
    if mode == "chain":
        rows, cols = board_dims(5 if skill < 4 else 6 if skill < 7 else 7)
        return LevelSpec(rows=rows, cols=cols, fill=1.0, low_first_moves=True,
                         target="MEDIUM" if skill < 6 else "HARD")
    if mode == "time_attack":
        return LevelSpec(rows=4, cols=5, fill=1.0, target="EASY" if skill < 5 else "MEDIUM",
                         max_attempts=4, rollouts=8)
    if mode == "daily":
        return LevelSpec(rows=6, cols=7, fill=1.0, blocked=2, target="HARD")
    if mode == "zen":
        return LevelSpec(rows=6, cols=6, fill=1.0, target="EASY" if skill < 4 else "MEDIUM")
    if mode == "expert":
        return LevelSpec(rows=7, cols=7, fill=1.0, blocked=5, frozen=5, wild=1, target="EXPERT")
    raise ValueError(f"unknown mode {mode}")


def par_time(pairs: int, skill: float) -> int:
    """Target clear time (seconds) - faster expectations for stronger players."""
    per_pair = max(2.5, 6.3 - 0.35 * skill)
    return int(round(pairs * per_pair / 5.0) * 5) or 5
