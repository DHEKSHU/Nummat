"""
Service layer - glue between the pure game engine and the database.

Routes stay thin; everything that touches both the engine and the models
lives here (starting/finishing games, stats, coins, achievements, adaptive
difficulty, leaderboards, daily challenge, analytics).
"""
from __future__ import annotations

import math
import os
import secrets
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func

from engine import achievements as ach_engine
from engine import difficulty as diff
from engine import session as S
from engine.generator import Level as GenLevel
from engine.generator import LevelSpec, generate_level, seed_from, stars_for
from engine.modes import (MODES, PACK_BY_ID, PACK_UNLOCK_REQUIREMENT, PACKS, board_dims, pack_level_size, par_time,
                          spec_for)

LEVEL_VERSION = "v2"   # bump when board generation changes, so cached boards are regenerated
from engine.predictor import DifficultyModel, features_from_games
from models import (Achievement, DailyChallenge, Game, Level, Move, PlayerStats, User, UserAchievement, db,
                    utcnow)

SHOP_ITEMS = [
    {"id": "shuffle", "name": "Shuffle", "icon": "🔀", "price": 100, "desc": "Reshuffle the remaining tiles."},
    {"id": "smart_hint", "name": "Smart Hint", "icon": "💡", "price": 150,
     "desc": "The solver's optimal move, free of your hint allowance."},
    {"id": "time_freeze", "name": "Time Freeze", "icon": "⏱", "price": 200, "desc": "+15 seconds on the clock."},
    {"id": "streak_shield", "name": "Streak Shield", "icon": "🔥", "price": 250,
     "desc": "Your next mistake won't break your streak."},
    {"id": "double_coins", "name": "Double Coins", "icon": "✨", "price": 300,
     "desc": "Double the coins earned by one game."},
]
SHOP_BY_ID = {i["id"]: i for i in SHOP_ITEMS}

_model_cache: Dict[str, DifficultyModel] = {}


# ---------------------------------------------------------------------------
# bootstrap
# ---------------------------------------------------------------------------
def seed_achievements() -> None:
    existing = {a.id for a in Achievement.query.all()}
    for a in ach_engine.ACHIEVEMENTS:
        row = db.session.get(Achievement, a["id"]) if a["id"] in existing else Achievement(id=a["id"])
        row.name, row.desc, row.category, row.icon, row.reward = a["name"], a["desc"], a["category"], a["icon"], a["reward"]
        db.session.add(row)
    db.session.commit()


def difficulty_model(app_instance_path: str) -> DifficultyModel:
    path = os.path.join(app_instance_path, "difficulty_model.json")
    if path not in _model_cache:
        _model_cache[path] = DifficultyModel.load(path)
    return _model_cache[path]


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------
def create_user(username: Optional[str] = None, password_hash: Optional[str] = None, guest: bool = True) -> User:
    user = User(username=username or f"guest-{secrets.token_hex(5)}", password_hash=password_hash,
                is_guest=guest, inventory={"shuffle": 1})
    user.stats = PlayerStats()
    db.session.add(user)
    db.session.commit()
    return user


GUEST_USERNAME = "guest"


def shared_guest() -> User:
    """The one reusable guest profile (no more 'Guest 17', 'Guest 18', ...)."""
    user = User.query.filter_by(username=GUEST_USERNAME).first()
    if user is None:
        user = create_user(GUEST_USERNAME, guest=True)
    return user


def _last_player_file(instance_path: str) -> str:
    return os.path.join(instance_path, "last_player.txt")


def remember_player(instance_path: str, user: Optional[User]) -> None:
    """Desktop mode: remember who played last so they are logged in automatically next time."""
    path = _last_player_file(instance_path)
    try:
        if user is None:
            if os.path.exists(path):
                os.remove(path)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(str(user.id))
    except OSError:
        pass


def last_player(instance_path: str) -> Optional[User]:
    try:
        with open(_last_player_file(instance_path), encoding="utf-8") as f:
            return db.session.get(User, int(f.read().strip()))
    except (OSError, ValueError):
        return None


def list_players() -> List[Dict]:
    """Players on this computer, most recently played first (for the 'Who's playing?' screen)."""
    users = (User.query.filter(User.is_guest.is_(False))
             .order_by(User.last_seen.desc()).limit(24).all())
    return [{"id": u.id, "name": u.username, "level": player_level(u.xp)[0], "coins": u.coins,
             "has_pin": bool(u.password_hash), "last_seen": u.last_seen.isoformat() if u.last_seen else None}
            for u in users]


def ensure_stats(user: User) -> PlayerStats:
    if user.stats is None:
        user.stats = PlayerStats()
        db.session.commit()
    return user.stats


def player_level(xp: int) -> Tuple[int, int, int]:
    """(level, xp into level, xp needed for next level)."""
    lvl = int(math.sqrt(max(0, xp) / 50)) + 1
    floor_xp = 50 * (lvl - 1) ** 2
    next_xp = 50 * lvl ** 2
    return lvl, xp - floor_xp, next_xp - floor_xp


def unlocked_ids(user: User) -> List[str]:
    return [ua.achievement_id for ua in user.achievements]


def profile(user: User) -> Dict:
    st = ensure_stats(user)
    lvl, into, need = player_level(user.xp)
    return {
        "id": user.id,
        "username": user.display_name,
        "is_guest": user.is_guest,
        "level": lvl,
        "xp": user.xp,
        "xp_into_level": into,
        "xp_for_next": need,
        "coins": user.coins,
        "skill": round(user.skill, 1),
        "best_streak": st.highest_streak,
        "achievements_unlocked": len(user.achievements),
        "achievements_total": len(ach_engine.ACHIEVEMENTS),
        "inventory": user.inventory or {},
        "theme": user.theme or "classic",
        "daily_streak": daily_streak(user),
        "tutorial_done": bool(user.tutorial_done),
        "has_pin": bool(user.password_hash),
    }


# ---------------------------------------------------------------------------
# history / skill
# ---------------------------------------------------------------------------
def recent_summaries(user: User, n: int = 30) -> List[Dict]:
    games = (user.games.filter(Game.finalized.is_(True), Game.status != "abandoned")
             .order_by(Game.ended_at.desc()).limit(n).all())
    return [g.summary() for g in reversed(games)]


def compute_skill(user: User, model: Optional[DifficultyModel] = None) -> float:
    history = [g for g in recent_summaries(user, diff.WINDOW) if g["mode"] != "zen"]
    pred = model.predict(features_from_games(history)) if (model and history) else None
    return diff.skill_from_history(history, model_prediction=pred)


def adaptive_report(user: User) -> Dict:
    history = [g for g in recent_summaries(user, diff.WINDOW) if g["mode"] != "zen"]
    skill = user.skill
    return {
        "performance": diff.performance_report(history),
        "skill": round(skill, 1),
        "trend": diff.trend(history),
        "next": diff.recommend(skill),
        "reasons": diff.explain_adjustment(history, skill),
    }


# ---------------------------------------------------------------------------
# packs & levels
# ---------------------------------------------------------------------------
def completed_levels(user: User) -> Dict[str, Dict[int, Dict]]:
    rows = (db.session.query(Game.pack, Game.level_index, func.min(Game.duration), func.min(Game.attempts),
                             func.max(Game.score))
            .filter(Game.user_id == user.id, Game.won.is_(True), Game.pack.isnot(None))
            .group_by(Game.pack, Game.level_index).all())
    out: Dict[str, Dict[int, Dict]] = {}
    for pack, idx, best_t, best_m, best_s in rows:
        out.setdefault(pack, {})[idx] = {"best_time": best_t, "best_moves": best_m, "best_score": best_s}
    return out


def pack_unlocked(done: Dict[str, Dict], pack_id: str) -> bool:
    ids = [p["id"] for p in PACKS]
    i = ids.index(pack_id)
    if i == 0:
        return True
    prev = PACKS[i - 1]
    need = min(PACK_UNLOCK_REQUIREMENT, prev["total_levels"])
    return len(done.get(prev["id"], {})) >= need


def list_packs(user: User) -> List[Dict]:
    done = completed_levels(user)
    out = []
    for p in PACKS:
        item = dict(p)
        item["completed_count"] = len(done.get(p["id"], {}))
        item["available"] = pack_unlocked(done, p["id"])
        item["unlock_hint"] = None if item["available"] else \
            f"Clear {min(PACK_UNLOCK_REQUIREMENT, PACKS[PACKS.index(p) - 1]['total_levels'])} levels of {PACKS[PACKS.index(p) - 1]['title']}"
        out.append(item)
    return out


def list_levels(user: User, pack_id: str) -> List[Dict]:
    p = PACK_BY_ID[pack_id]
    done = completed_levels(user).get(pack_id, {})
    out = []
    for i in range(1, p["total_levels"] + 1):
        rows, cols = board_dims(pack_level_size(i))
        rec = done.get(i)
        out.append({"index": i, "rows": rows, "cols": cols, "completed": rec is not None,
                    "locked": not (i == 1 or (i - 1) in done),
                    "best_time": rec and rec["best_time"], "best_moves": rec and rec["best_moves"],
                    "best_score": rec and rec["best_score"],
                    "rewards": {"coins": 10 + i * 2}})
    return out


def _cached_level(key: str, mode: str, spec: LevelSpec, seed: int, pack=None, index=None) -> Level:
    row = Level.query.filter_by(key=key).first()
    if row:
        return row
    gen = generate_level(spec, seed)
    row = Level(key=key, mode=mode, pack=pack, index=index, seed=seed, rows=len(gen.grid), cols=len(gen.grid[0]),
                grid=gen.grid, frozen=[list(p) for p in gen.frozen],
                solution=[[list(a), list(b)] for a, b in gen.solution], metrics=gen.metrics,
                difficulty=gen.difficulty, difficulty_score=gen.difficulty_score)
    db.session.add(row)
    db.session.commit()
    return row


def _as_gen(row: Level) -> GenLevel:
    return GenLevel(grid=row.grid, frozen=[tuple(p) for p in row.frozen or []], seed=row.seed,
                    metrics=row.metrics or {}, difficulty=row.difficulty, difficulty_score=row.difficulty_score,
                    attempts=0)


# ---------------------------------------------------------------------------
# daily challenge
# ---------------------------------------------------------------------------
def today_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def daily_challenge(date: Optional[str] = None) -> DailyChallenge:
    date = date or today_utc()
    row = DailyChallenge.query.filter_by(date=date).first()
    if row:
        return row
    seed = int(date.replace("-", ""))            # e.g. 2026-09-27 -> 20260927 (same for everyone)
    level = _cached_level(f"daily:{date}:{LEVEL_VERSION}", "daily", spec_for("daily", 5.0), seed)
    row = DailyChallenge(date=date, seed=seed, level_id=level.id, difficulty=level.difficulty,
                         stars=stars_for(level.difficulty))
    db.session.add(row)
    db.session.commit()
    return row


def daily_leaderboard(date: str, limit: int = 10) -> List[Dict]:
    rows = (db.session.query(User, func.max(Game.score).label("best"))
            .join(Game, Game.user_id == User.id)
            .filter(Game.mode == "daily", Game.daily_date == date, Game.finalized.is_(True))
            .group_by(User.id).order_by(func.max(Game.score).desc()).limit(limit).all())
    return [{"rank": i + 1, "player": u.display_name, "score": best, "user_id": u.id}
            for i, (u, best) in enumerate(rows)]


def daily_info(user: User) -> Dict:
    d = daily_challenge()
    best = (db.session.query(func.max(Game.score))
            .filter(Game.user_id == user.id, Game.mode == "daily", Game.daily_date == d.date,
                    Game.finalized.is_(True)).scalar())
    played = (Game.query.filter_by(user_id=user.id, mode="daily", daily_date=d.date, finalized=True).count())
    return {"date": d.date, "seed": d.seed, "difficulty": d.difficulty, "stars": d.stars,
            "move_limit": MODES["daily"].move_limit, "your_best": best, "attempts": played,
            "rows": d.level.rows, "cols": d.level.cols, "leaderboard": daily_leaderboard(d.date)}


def daily_streak(user: User) -> int:
    dates = {r[0] for r in db.session.query(Game.daily_date)
             .filter(Game.user_id == user.id, Game.mode == "daily", Game.finalized.is_(True)).distinct()}
    day = datetime.now(timezone.utc).date()
    if day.isoformat() not in dates:
        day -= timedelta(days=1)
    n = 0
    while day.isoformat() in dates:
        n += 1
        day -= timedelta(days=1)
    return n


# ---------------------------------------------------------------------------
# games
# ---------------------------------------------------------------------------
def start_game(user: User, mode: str, pack: Optional[str] = None, level_index: Optional[int] = None) -> Game:
    if mode not in MODES:
        raise ValueError("Unknown mode")
    # one active game per player
    for g in user.games.filter_by(status="active").all():
        st = g.state
        S.abandon(st)
        g.set_state(st)
        finalize(user, g, silent=True)

    skill = user.skill
    rec = diff.recommend(skill)
    hints_override = None
    par = None
    daily_date = None

    if mode == "classic" and pack:
        if pack not in PACK_BY_ID:
            raise ValueError("Unknown pack")
        total = PACK_BY_ID[pack]["total_levels"]
        level_index = max(1, min(total, int(level_index or 1)))
        done = completed_levels(user)
        if not pack_unlocked(done, pack):
            raise PermissionError("This pack is locked.")
        if level_index > 1 and (level_index - 1) not in done.get(pack, {}):
            raise PermissionError("Complete the previous level first.")
        spec = spec_for("classic", skill, pack, level_index)
        seed = seed_from(pack, level_index, spec.target)
        row = _cached_level(f"{pack}_{level_index:03d}:{spec.target}:{LEVEL_VERSION}", mode, spec, seed, pack, level_index)
        par = par_time(len([v for r in row.grid for v in r if v > 0]) // 2, skill)
    elif mode == "daily":
        d = daily_challenge()
        row, spec, daily_date = d.level, spec_for("daily", 5.0), d.date
    else:
        spec = spec_for(mode, skill, recommendation=rec)
        seed = seed_from(mode, user.id, secrets.token_hex(8))
        row = _cached_level(f"{mode}:{seed}:{LEVEL_VERSION}", mode, spec, seed)
        if mode == "classic":
            hints_override = rec["hints"]
            par = rec["time"]

    state = S.new_state(mode, _as_gen(row), pack=pack, level_index=level_index, level_key=row.key, par=par,
                        spec=asdict(spec), hints_override=hints_override)
    game = Game(user=user, level_id=row.id, mode=mode, pack=pack, level_index=level_index,
                daily_date=daily_date, difficulty=row.difficulty, difficulty_score=row.difficulty_score,
                skill_before=skill)
    game.set_state(state)
    db.session.add(game)
    user.last_seen = utcnow()
    db.session.commit()
    return game


def record_move(game: Game, state_before_grid, p1, p2, event: Dict) -> None:
    seq = (game.state or {}).get("attempts", 0)
    v1 = state_before_grid[p1[0]][p1[1]] if _in(state_before_grid, p1) else None
    v2 = state_before_grid[p2[0]][p2[1]] if _in(state_before_grid, p2) else None
    db.session.add(Move(game_id=game.id, seq=seq, r1=p1[0], c1=p1[1], r2=p2[0], c2=p2[1], v1=v1, v2=v2,
                        valid=bool(event.get("valid")),
                        connection=(event.get("explain") or {}).get("connection"),
                        points=event.get("points", 0), t=S.elapsed(game.state)))


def _in(grid, p) -> bool:
    return 0 <= p[0] < len(grid) and 0 <= p[1] < len(grid[0])


def award(user: User, ids: List[str]) -> List[Dict]:
    out = []
    for aid in ids:
        a = ach_engine.BY_ID[aid]
        db.session.add(UserAchievement(user_id=user.id, achievement_id=aid))
        user.coins += a["reward"]
        out.append(ach_engine.public(a))
    return out


def move_achievements(user: User, state: Dict) -> List[Dict]:
    ctx = {"event": "move", "streak": state["streak"], "chain": state["chain"],
           "stats": ensure_stats(user).to_dict(), "unlocked": unlocked_ids(user), "skill": user.skill}
    ctx["stats"]["total_matches"] += state["matches"]
    return award(user, ach_engine.evaluate(ctx))


def finalize(user: User, game: Game, silent: bool = False, instance_path: Optional[str] = None) -> Optional[Dict]:
    """Close a finished game: stats, coins, XP, achievements, adaptive skill. Idempotent."""
    state = game.state
    if game.finalized or state["status"] == "active":
        return None
    summ = S.summary(state)
    game.status = state["status"]
    game.won = bool(summ["won"])
    for k in ("score", "matches", "attempts", "mistakes", "hints_used", "undos_used", "max_streak",
              "max_chain", "deadlocks", "duration", "assisted"):
        setattr(game, k, summ[k])
    game.ended_at = utcnow()
    game.finalized = True

    if state["status"] == "abandoned":
        game.skill_after = user.skill
        db.session.commit()
        return None

    st = ensure_stats(user)
    first_clear = False
    if game.won and game.pack:
        first_clear = not (Game.query.filter(Game.user_id == user.id, Game.pack == game.pack,
                                             Game.level_index == game.level_index, Game.won.is_(True),
                                             Game.id != game.id).count())
    st.games_played += 1
    st.games_won += int(game.won)
    st.total_matches += summ["matches"]
    st.total_moves += summ["matches"]
    st.total_attempts += summ["attempts"]
    st.total_mistakes += summ["mistakes"]
    st.hints_used += summ["hints_used"]
    st.undos_used += summ["undos_used"]
    st.deadlocks += summ["deadlocks"]
    st.total_time_played += summ["duration"]
    st.total_score += summ["score"]
    st.highest_streak = max(st.highest_streak, summ["max_streak"])
    if game.won and game.mode != "time_attack":
        st.levels_completed += 1
    if game.won and summ["mistakes"] == 0 and summ["attempts"] > 0:
        st.perfect_games += 1
    if game.won and game.mode == "zen":
        st.zen_clears += 1

    # coins - earned only through play
    coins = summ["score"] // 40 if game.mode != "zen" else (10 if game.won else 0)
    if first_clear:
        coins += 10 + 2 * (game.level_index or 1)
    if game.mode == "daily":
        earlier = Game.query.filter(Game.user_id == user.id, Game.mode == "daily",
                                    Game.daily_date == game.daily_date, Game.finalized.is_(True),
                                    Game.id != game.id).count()
        if not earlier:
            coins += 100 if game.won else 40
    if state.get("double_coins"):
        coins *= 2
    user.coins += coins
    xp = max(5, summ["score"] // 10)
    user.xp += xp
    db.session.flush()

    # adaptive skill
    level_before, _, _ = player_level(user.xp - xp)
    model = difficulty_model(instance_path) if instance_path else None
    if game.mode != "zen":
        user.skill = compute_skill(user, model)
    game.skill_after = user.skill
    game.coins_earned = coins

    # achievements
    done = completed_levels(user)
    ctx = {"event": "finish", "game": summ, "streak": summ["max_streak"], "chain": summ["max_chain"],
           "stats": st.to_dict(), "skill": user.skill, "unlocked": unlocked_ids(user),
           "packs_won": set(done.keys()),
           "packs_complete": {p["id"] for p in PACKS if len(done.get(p["id"], {})) >= p["total_levels"]}}
    new = award(user, ach_engine.evaluate(ctx))
    db.session.commit()

    level_after, _, _ = player_level(user.xp)
    return {
        "summary": summ,
        "coins_earned": coins,
        "achievement_coins": sum(a["reward"] for a in new),
        "xp_earned": xp,
        "level_up": level_after > level_before,
        "new_achievements": new,
        "skill_before": game.skill_before,
        "skill_after": user.skill,
        "first_clear": first_clear,
        "next": diff.recommend(user.skill),
    }


# ---------------------------------------------------------------------------
# shop
# ---------------------------------------------------------------------------
def buy(user: User, item_id: str) -> Tuple[bool, str]:
    item = SHOP_BY_ID.get(item_id)
    if not item:
        return False, "Unknown item."
    if user.coins < item["price"]:
        return False, f"Not enough coins - {item['price'] - user.coins} more needed."
    user.coins -= item["price"]
    inv = dict(user.inventory or {})
    inv[item_id] = inv.get(item_id, 0) + 1
    user.set_inventory(inv)
    db.session.commit()
    return True, f"Purchased {item['name']}!"


def consume_item(user: User, item_id: str) -> bool:
    inv = dict(user.inventory or {})
    if inv.get(item_id, 0) <= 0:
        return False
    inv[item_id] -= 1
    user.set_inventory(inv)
    return True


# ---------------------------------------------------------------------------
# leaderboards & analytics
# ---------------------------------------------------------------------------
def leaderboard(period: str = "all", limit: int = 20) -> List[Dict]:
    q = (db.session.query(User, func.sum(Game.score).label("total"), func.count(Game.id), func.max(Game.score))
         .join(Game, Game.user_id == User.id)
         .filter(Game.finalized.is_(True), Game.status != "abandoned", Game.mode != "zen"))
    now = utcnow()
    if period == "daily":
        q = q.filter(Game.ended_at >= now.replace(hour=0, minute=0, second=0, microsecond=0))
    elif period == "weekly":
        q = q.filter(Game.ended_at >= now - timedelta(days=7))
    rows = q.group_by(User.id).order_by(func.sum(Game.score).desc()).limit(limit).all()
    return [{"rank": i + 1, "player": u.display_name, "user_id": u.id, "score": int(total or 0), "games": n,
             "best": int(best or 0), "level": player_level(u.xp)[0]}
            for i, (u, total, n, best) in enumerate(rows)]


def analytics(user: User) -> Dict:
    st = ensure_stats(user)
    games = recent_summaries(user, 40)
    won = [g for g in games if g["won"] and g["mode"] != "time_attack"]
    attempts = st.total_attempts or 0
    by_mode: Dict[str, Dict] = {}
    for g in games:
        m = by_mode.setdefault(g["mode"], {"games": 0, "won": 0, "best": 0})
        m["games"] += 1
        m["won"] += int(g["won"])
        m["best"] = max(m["best"], g["score"])
    tiers = {t: 0 for t in ("EASY", "MEDIUM", "HARD", "EXPERT")}
    for g in won:
        if g["difficulty"] in tiers:
            tiers[g["difficulty"]] += 1
    solve_times = [g["duration"] for g in won]
    return {
        "profile": profile(user),
        "table": {
            "levels_completed": st.levels_completed,
            "total_matches": st.total_matches,
            "best_streak": st.highest_streak,
            "avg_solve_time": round(sum(solve_times) / len(solve_times), 1) if solve_times else None,
            "accuracy": round(100 * (attempts - st.total_mistakes) / attempts) if attempts else None,
            "games_played": st.games_played,
            "win_rate": round(100 * st.games_won / st.games_played) if st.games_played else None,
            "time_played": round(st.total_time_played),
            "hints_used": st.hints_used,
            "undos_used": st.undos_used,
            "deadlocks": st.deadlocks,
            "total_score": st.total_score,
        },
        "series": {
            "labels": [f"#{i + 1}" for i in range(len(games))],
            "score": [g["score"] for g in games],
            "solve_time": [g["duration"] if g["won"] else None for g in games],
            "accuracy": [round(100 * (g["attempts"] - g["mistakes"]) / g["attempts"]) if g["attempts"] else None
                         for g in games],
            "skill": [g["skill_after"] for g in games],
            "streak": [g["max_streak"] for g in games],
            "hints": [g["hints_used"] for g in games],
            "difficulty": [g["difficulty_score"] for g in games],
        },
        "by_mode": by_mode,
        "tiers": tiers,
        "adaptive": adaptive_report(user),
    }


def achievements_for(user: User) -> Dict:
    have = {ua.achievement_id: ua.unlocked_at for ua in user.achievements}
    cats = {c: [] for c in ach_engine.CATEGORIES}
    for a in ach_engine.ACHIEVEMENTS:
        item = ach_engine.public(a)
        item["unlocked"] = a["id"] in have
        item["unlocked_at"] = have[a["id"]].isoformat() if a["id"] in have else None
        cats[a["category"]].append(item)
    return {"categories": cats, "unlocked": len(have), "total": len(ach_engine.ACHIEVEMENTS)}
