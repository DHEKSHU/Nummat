"""
NUMMAT - Think. Match. Clear.

    Frontend (templates/index.html + static/)
        ↓  fetch / JSON
    Flask REST API (api.py)
        ↓
    Service layer (services.py)  ─── Game Engine (engine/)
        ↓
    SQLite via SQLAlchemy (models.py)

Run in a browser:   python app.py        → http://127.0.0.1:5000
Run as desktop app: python desktop.py    (or the PyInstaller build)

Environment variables
    NUMMAT_INSTANCE_DIR   folder for the database + secret key
                          (default: ./instance, or the user data folder when packaged)
    NUMMAT_DATABASE_URL   full SQLAlchemy URL (overrides the instance-folder database)
    NUMMAT_SECRET_KEY     session secret (default: generated once into the instance folder)
    FLASK_DEBUG / HOST / PORT
"""
from __future__ import annotations

import os
import secrets
import sys
from datetime import timedelta
from pathlib import Path

from flask import Flask, render_template

APP_NAME = "NUMMAT"
FROZEN = getattr(sys, "frozen", False)          # True inside a PyInstaller build

# Where the code, templates and static files live.
# In a PyInstaller build they are unpacked to a temporary folder (sys._MEIPASS).
BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from models import db  # noqa: E402  (needs BASE_DIR on sys.path when frozen)


def user_data_dir() -> Path:
    """Per-user, writable folder for saves (used by packaged desktop builds)."""
    if sys.platform.startswith("win"):
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return root / APP_NAME


def instance_dir() -> Path:
    """Folder holding the SQLite database and secret key. Must survive restarts."""
    env = os.environ.get("NUMMAT_INSTANCE_DIR")
    if env:
        path = Path(env)
    elif FROZEN:
        path = user_data_dir()               # the unpack folder is temporary - never save there
    else:
        path = BASE_DIR / "instance"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _secret_key(folder: Path) -> str:
    env = os.environ.get("NUMMAT_SECRET_KEY")
    if env:
        return env
    path = folder / "secret_key"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    path.write_text(key, encoding="utf-8")
    return key


def _migrate(database) -> None:
    """Add columns introduced after a save file was created (SQLite has no auto-migrate)."""
    from sqlalchemy import inspect, text
    added = {"users": {"tutorial_done": "BOOLEAN NOT NULL DEFAULT 0"}}
    insp = inspect(database.engine)
    with database.engine.begin() as conn:
        for table, cols in added.items():
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in cols.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                    if name == "tutorial_done":   # existing players have already learned the game
                        conn.execute(text("UPDATE users SET tutorial_done = 1 WHERE is_guest = 0"))


def create_app(test_config: dict | None = None) -> Flask:
    inst = instance_dir()
    app = Flask(
        __name__,
        instance_path=str(inst),
        instance_relative_config=True,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
    )
    app.config.update(
        SQLALCHEMY_DATABASE_URI=os.environ.get("NUMMAT_DATABASE_URL", f"sqlite:///{(inst / 'nummat.db').as_posix()}"),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        PERMANENT_SESSION_LIFETIME=timedelta(days=90),
        SESSION_COOKIE_SAMESITE="Lax",
        SEND_FILE_MAX_AGE_DEFAULT=0 if not FROZEN else 3600,
    )
    # Desktop mode (set by desktop.py): one computer, several local players.
    # Remembers the last player and shows a "Who's playing?" list. Off for web deployments.
    desktop = os.environ.get("NUMMAT_DESKTOP") == "1"
    app.config.update(REMEMBER_LAST_PLAYER=desktop, LIST_PLAYERS=desktop)
    if test_config:
        app.config.update(test_config)
    if not app.config.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = _secret_key(inst)

    app.json.sort_keys = False      # keep category / tier order as defined
    db.init_app(app)

    from api import bp as api_bp
    app.register_blueprint(api_bp)

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    with app.app_context():
        import services
        db.create_all()
        _migrate(db)
        services.seed_achievements()

    return app


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "0" if FROZEN else "1") == "1"
    create_app().run(
        debug=debug,
        use_reloader=debug and not FROZEN,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 5000)),
    )