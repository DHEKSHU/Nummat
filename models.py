"""
Database models (Flask-SQLAlchemy + SQLite).

    users ─┬─ player_stats        (1:1 lifetime counters)
           ├─ games ── moves      (every game and every attempted move)
           │     └── levels       (generated boards, cached by key + seed)
           ├─ user_achievements ── achievements
           └─ daily_challenges    (one seeded level per day)
"""
from __future__ import annotations

from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm.attributes import flag_modified

db = SQLAlchemy()


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(32), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256))
    is_guest = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)
    last_seen = db.Column(db.DateTime, default=utcnow)
    coins = db.Column(db.Integer, default=100, nullable=False)
    xp = db.Column(db.Integer, default=0, nullable=False)
    skill = db.Column(db.Float, default=3.0, nullable=False)
    theme = db.Column(db.String(16), default="classic")
    inventory = db.Column(db.JSON, default=lambda: {"shuffle": 1})
    tutorial_done = db.Column(db.Boolean, default=False, nullable=False)

    stats = db.relationship("PlayerStats", uselist=False, back_populates="user", cascade="all, delete-orphan")
    games = db.relationship("Game", back_populates="user", lazy="dynamic", cascade="all, delete-orphan")
    achievements = db.relationship("UserAchievement", back_populates="user", cascade="all, delete-orphan")

    @property
    def display_name(self) -> str:
        return "Guest" if self.is_guest else self.username

    def set_inventory(self, inv: dict) -> None:
        self.inventory = dict(inv)
        flag_modified(self, "inventory")


class PlayerStats(db.Model):
    __tablename__ = "player_stats"
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), primary_key=True)
    total_matches = db.Column(db.Integer, default=0, nullable=False)
    highest_streak = db.Column(db.Integer, default=0, nullable=False)
    total_time_played = db.Column(db.Float, default=0.0, nullable=False)
    levels_completed = db.Column(db.Integer, default=0, nullable=False)
    total_moves = db.Column(db.Integer, default=0, nullable=False)
    total_attempts = db.Column(db.Integer, default=0, nullable=False)
    total_mistakes = db.Column(db.Integer, default=0, nullable=False)
    hints_used = db.Column(db.Integer, default=0, nullable=False)
    undos_used = db.Column(db.Integer, default=0, nullable=False)
    deadlocks = db.Column(db.Integer, default=0, nullable=False)
    games_played = db.Column(db.Integer, default=0, nullable=False)
    games_won = db.Column(db.Integer, default=0, nullable=False)
    perfect_games = db.Column(db.Integer, default=0, nullable=False)
    zen_clears = db.Column(db.Integer, default=0, nullable=False)
    total_score = db.Column(db.Integer, default=0, nullable=False)

    user = db.relationship("User", back_populates="stats")

    def to_dict(self) -> dict:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns if c.name != "user_id"}


class Level(db.Model):
    __tablename__ = "levels"
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(80), unique=True, nullable=False, index=True)
    mode = db.Column(db.String(16), nullable=False)
    pack = db.Column(db.String(32))
    index = db.Column(db.Integer)
    seed = db.Column(db.BigInteger, nullable=False)
    rows = db.Column(db.Integer, nullable=False)
    cols = db.Column(db.Integer, nullable=False)
    grid = db.Column(db.JSON, nullable=False)
    frozen = db.Column(db.JSON, default=list)
    solution = db.Column(db.JSON, default=list)
    metrics = db.Column(db.JSON, default=dict)
    difficulty = db.Column(db.String(8))
    difficulty_score = db.Column(db.Float)
    created_at = db.Column(db.DateTime, default=utcnow)


class Game(db.Model):
    __tablename__ = "games"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    level_id = db.Column(db.Integer, db.ForeignKey("levels.id"))
    mode = db.Column(db.String(16), nullable=False, index=True)
    pack = db.Column(db.String(32))
    level_index = db.Column(db.Integer)
    daily_date = db.Column(db.String(10), index=True)
    status = db.Column(db.String(12), default="active", nullable=False, index=True)
    finalized = db.Column(db.Boolean, default=False, nullable=False)
    won = db.Column(db.Boolean, default=False, nullable=False)
    score = db.Column(db.Integer, default=0, nullable=False)
    matches = db.Column(db.Integer, default=0)
    attempts = db.Column(db.Integer, default=0)
    mistakes = db.Column(db.Integer, default=0)
    hints_used = db.Column(db.Integer, default=0)
    undos_used = db.Column(db.Integer, default=0)
    max_streak = db.Column(db.Integer, default=0)
    max_chain = db.Column(db.Integer, default=0)
    deadlocks = db.Column(db.Integer, default=0)
    duration = db.Column(db.Float, default=0.0)
    difficulty = db.Column(db.String(8))
    difficulty_score = db.Column(db.Float)
    assisted = db.Column(db.Boolean, default=False)
    coins_earned = db.Column(db.Integer, default=0)
    skill_before = db.Column(db.Float)
    skill_after = db.Column(db.Float)
    started_at = db.Column(db.DateTime, default=utcnow, index=True)
    ended_at = db.Column(db.DateTime, index=True)
    state = db.Column(db.JSON)

    user = db.relationship("User", back_populates="games")
    level = db.relationship("Level")
    moves = db.relationship("Move", back_populates="game", lazy="dynamic", cascade="all, delete-orphan")

    def set_state(self, state: dict) -> None:
        self.state = state
        flag_modified(self, "state")

    def summary(self) -> dict:
        return {
            "id": self.id, "mode": self.mode, "pack": self.pack, "level_index": self.level_index,
            "won": self.won, "status": self.status, "score": self.score, "matches": self.matches,
            "attempts": self.attempts, "mistakes": self.mistakes, "hints_used": self.hints_used,
            "undos_used": self.undos_used, "max_streak": self.max_streak, "max_chain": self.max_chain,
            "deadlocks": self.deadlocks, "duration": self.duration, "difficulty": self.difficulty,
            "difficulty_score": self.difficulty_score or 0, "assisted": self.assisted,
            "pairs": (self.state or {}).get("pairs_total", max(1, self.matches)),
            "skill_after": self.skill_after, "ended_at": self.ended_at.isoformat() if self.ended_at else None,
        }


class Move(db.Model):
    __tablename__ = "moves"
    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(db.Integer, db.ForeignKey("games.id"), nullable=False, index=True)
    seq = db.Column(db.Integer, nullable=False)
    r1 = db.Column(db.Integer)
    c1 = db.Column(db.Integer)
    r2 = db.Column(db.Integer)
    c2 = db.Column(db.Integer)
    v1 = db.Column(db.Integer)
    v2 = db.Column(db.Integer)
    valid = db.Column(db.Boolean, nullable=False)
    connection = db.Column(db.String(10))
    points = db.Column(db.Integer, default=0)
    t = db.Column(db.Float)          # seconds since the game started
    created_at = db.Column(db.DateTime, default=utcnow)

    game = db.relationship("Game", back_populates="moves")


class Achievement(db.Model):
    __tablename__ = "achievements"
    id = db.Column(db.String(32), primary_key=True)
    name = db.Column(db.String(64), nullable=False)
    desc = db.Column(db.String(160))
    category = db.Column(db.String(16))
    icon = db.Column(db.String(8))
    reward = db.Column(db.Integer, default=0)


class UserAchievement(db.Model):
    __tablename__ = "user_achievements"
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), primary_key=True)
    achievement_id = db.Column(db.String(32), db.ForeignKey("achievements.id"), primary_key=True)
    unlocked_at = db.Column(db.DateTime, default=utcnow)

    user = db.relationship("User", back_populates="achievements")
    achievement = db.relationship("Achievement")


class DailyChallenge(db.Model):
    __tablename__ = "daily_challenges"
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.String(10), unique=True, nullable=False, index=True)
    seed = db.Column(db.BigInteger, nullable=False)
    level_id = db.Column(db.Integer, db.ForeignKey("levels.id"), nullable=False)
    difficulty = db.Column(db.String(8))
    stars = db.Column(db.Integer, default=3)

    level = db.relationship("Level")
