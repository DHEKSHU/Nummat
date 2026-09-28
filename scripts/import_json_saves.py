"""
Import legacy JSON saves (saves/<name>.json from NUMMAT v1) into the SQLite database.

    python scripts/import_json_saves.py [saves_dir]

Each file becomes a user with the same name, its coins, stats and achievements,
and one "won" game per completed level (with the recorded best time / moves).
Imported users have no password; the first person to register with that
username claims the account and keeps the progress.
"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import create_app  # noqa: E402
from engine.achievements import BY_ID  # noqa: E402
from models import Game, PlayerStats, User, UserAchievement, db, utcnow  # noqa: E402

LEGACY_ITEMS = {"shuffle": "shuffle", "auto_match": "smart_hint"}


def import_file(path: str) -> str:
    name = os.path.splitext(os.path.basename(path))[0]
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    username = name if name.lower() != "guest" else "legacy_guest"
    if User.query.filter(db.func.lower(User.username) == username.lower()).first():
        return f"skip {username}: already exists"
    user = User(username=username, is_guest=False, password_hash=None, coins=int(data.get("coins", 100)))
    inv = {}
    for old, new in LEGACY_ITEMS.items():
        n = int((data.get("powerups") or {}).get(old, 0))
        if n:
            inv[new] = inv.get(new, 0) + n
    user.inventory = inv or {"shuffle": 1}
    s = data.get("stats") or {}
    user.stats = PlayerStats(total_matches=s.get("total_matches", 0), highest_streak=s.get("highest_streak", 0),
                             total_time_played=s.get("total_time_played", 0), levels_completed=s.get("levels_completed", 0),
                             total_moves=s.get("total_moves", 0), total_attempts=s.get("total_moves", 0),
                             games_played=s.get("levels_completed", 0), games_won=s.get("levels_completed", 0))
    db.session.add(user)
    db.session.flush()
    for aid in data.get("achievements", []):
        if aid in BY_ID:
            db.session.add(UserAchievement(user_id=user.id, achievement_id=aid))
    best_t, best_m = data.get("best_times", {}), data.get("best_moves", {})
    for pack, level_ids in (data.get("completed") or {}).items():
        for lid in level_ids:
            try:
                idx = int(lid.rsplit("_", 1)[1])
            except (IndexError, ValueError):
                continue
            moves = int(best_m.get(lid, 0))
            db.session.add(Game(user_id=user.id, mode="classic", pack=pack, level_index=idx, status="won",
                                won=True, finalized=True, duration=float(best_t.get(lid, 0)), matches=moves,
                                attempts=moves, ended_at=utcnow(), state={"pairs_total": moves}))
    db.session.commit()
    return f"imported {username}"


def main() -> None:
    saves = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "saves")
    app = create_app()
    with app.app_context():
        for fn in sorted(os.listdir(saves)):
            if fn.endswith(".json"):
                print(import_file(os.path.join(saves, fn)))


if __name__ == "__main__":
    main()
