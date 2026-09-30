"""
REST API.

Players         POST /api/auth/register | /login | /guest | /logout | /pin    GET /api/me | /api/players
                POST /api/tutorial/done
Catalogue       GET  /api/modes | /api/packs | /api/packs/<pack>/levels | /api/daily
Games           POST /api/games                         start (mode, pack, level)
                GET  /api/games/<id>                    state (also finalises timed-out games)
                POST /api/games/<id>/move               {a: [r, c], b: [r, c]}
                POST /api/games/<id>/undo
                POST /api/games/<id>/hint               {level: 1 | 2 | 3}
                POST /api/games/<id>/solve              {reveal: bool}
                POST /api/games/<id>/item               {item}
                POST /api/games/<id>/end
Solver lab      POST /api/solver                        {board: "text"}
Progression     GET  /api/stats | /api/achievements | /api/skill | /api/leaderboard?period=
Shop            GET  /api/shop      POST /api/shop/buy  {item}
Settings        POST /api/settings                      {theme}
"""
from __future__ import annotations

import re

from flask import Blueprint, current_app, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

import services as svc
from engine import session as S
from engine.generator import measure
from engine.modes import MODES, PACK_BY_ID
from engine.rules import parse_grid_text
from engine.solver import solve
from models import Game, User, db, utcnow

bp = Blueprint("api", __name__, url_prefix="/api")

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _\-]{1,19}$")
THEMES = ("classic", "winter", "autumn", "spring", "summer")


class NeedLogin(Exception):
    """Raised when an endpoint needs a player and nobody is logged in."""


@bp.errorhandler(NeedLogin)
def _need_login(_e):
    return jsonify(success=False, needs_login=True, message="Choose a player first."), 401


def err(message: str, code: int = 400, **extra):
    return jsonify(success=False, message=message, **extra), code


def body() -> dict:
    return request.get_json(silent=True) or {}


def sign_in(user: User) -> None:
    session["uid"] = user.id
    session.permanent = True
    user.last_seen = utcnow()
    if current_app.config.get("REMEMBER_LAST_PLAYER"):
        svc.remember_player(current_app.instance_path, user)
    db.session.commit()


def current_user(required: bool = True):
    """The logged-in player.

    Desktop mode also restores the last player automatically, so you stay logged in
    between launches. If nobody is logged in, endpoints answer 401 needs_login and
    the app shows the "Who's playing?" screen.
    """
    uid = session.get("uid")
    user = db.session.get(User, uid) if uid else None
    if user is None and current_app.config.get("REMEMBER_LAST_PLAYER"):
        user = svc.last_player(current_app.instance_path)
        if user is not None:
            session["uid"] = user.id
            session.permanent = True
    if user is None and required:
        raise NeedLogin()
    return user


def game_or_404(user: User, game_id: int):
    game = db.session.get(Game, game_id)
    if not game or game.user_id != user.id:
        return None
    return game


def game_payload(user: User, game: Game, **extra):
    state = game.state
    result = None
    if S.check_timeout(state):
        game.set_state(state)
    if state["status"] != "active" and not game.finalized:
        result = svc.finalize(user, game, instance_path=current_app.instance_path)
    db.session.commit()
    return jsonify(success=True, game_id=game.id, game=S.public_view(state), result=result,
                   profile=svc.profile(user), **extra)


# ---------------------------------------------------------------- auth ----
def _clean_name(raw) -> str:
    return " ".join(str(raw or "").split())


def _check_pin(pin: str):
    if pin and len(pin) < 4:
        return "A PIN or password needs at least 4 characters (or leave it empty)."
    if len(pin) > 64:
        return "That PIN is too long."
    return None


def _find_user(name: str):
    return User.query.filter(db.func.lower(User.username) == name.lower(), User.is_guest.is_(False)).first()


@bp.post("/auth/register")
def register():
    """Create a player. The PIN / password is optional (like PopCap-style local profiles)."""
    data = body()
    name = _clean_name(data.get("username"))
    pin = str(data.get("password") or data.get("pin") or "")
    if not USERNAME_RE.match(name):
        return err("Names are 2-20 characters: letters, numbers, spaces, _ or -.")
    if name.lower().startswith("guest"):
        return err("That name is reserved - please pick another.")
    problem = _check_pin(pin)
    if problem:
        return err(problem)
    existing = User.query.filter(db.func.lower(User.username) == name.lower()).first()
    if existing and not existing.is_guest:
        if existing.password_hash is None and data.get("claim"):
            pass   # legacy imported save: fall through and claim it below
        else:
            return err("That name is taken - log in instead, or pick another name.")
    pin_hash = generate_password_hash(pin) if pin else None
    if existing:   # claim an imported v1 save
        existing.password_hash = pin_hash
        sign_in(existing)
        return jsonify(success=True, profile=svc.profile(existing), claimed=True)

    me = current_user(required=False)
    if me is not None and me.is_guest:
        # Upgrade the guest profile so its progress is kept; the next "Play as guest" starts fresh.
        me.username, me.password_hash, me.is_guest = name, pin_hash, False
        user = me
    else:
        user = svc.create_user(name, pin_hash, guest=False)
    sign_in(user)
    return jsonify(success=True, profile=svc.profile(user))


@bp.post("/auth/login")
def login():
    data = body()
    name = _clean_name(data.get("username"))
    pin = str(data.get("password") or data.get("pin") or "")
    user = None
    if data.get("user_id") and current_app.config.get("LIST_PLAYERS"):
        user = db.session.get(User, int(data["user_id"]))
        if user is not None and user.is_guest:
            user = None
    if user is None and name:
        user = _find_user(name)
    if user is None:
        return err("No player with that name on this computer.", 404)
    if user.password_hash and not check_password_hash(user.password_hash, pin):
        return err("Wrong PIN - try again.", 401, needs_pin=True)
    sign_in(user)
    return jsonify(success=True, profile=svc.profile(user))


@bp.post("/auth/guest")
def guest():
    user = svc.shared_guest()
    sign_in(user)
    return jsonify(success=True, profile=svc.profile(user))


@bp.post("/auth/logout")
def logout():
    """Switch player: forget who is logged in (the app returns to "Who's playing?")."""
    session.pop("uid", None)
    if current_app.config.get("REMEMBER_LAST_PLAYER"):
        svc.remember_player(current_app.instance_path, None)
    return jsonify(success=True, needs_login=True, players=_players())


@bp.post("/auth/pin")
def set_pin():
    """Add, change or remove your PIN (send an empty PIN to remove it)."""
    user = current_user()
    if user.is_guest:
        return err("Create a player first.")
    data = body()
    if user.password_hash and not check_password_hash(user.password_hash, str(data.get("current") or "")):
        return err("Your current PIN is not right.", 401)
    pin = str(data.get("pin") or "")
    problem = _check_pin(pin)
    if problem:
        return err(problem)
    user.password_hash = generate_password_hash(pin) if pin else None
    db.session.commit()
    return jsonify(success=True, profile=svc.profile(user))


def _players():
    return svc.list_players() if current_app.config.get("LIST_PLAYERS") else []


@bp.get("/players")
def players():
    return jsonify(success=True, players=_players())


@bp.get("/me")
def me():
    user = current_user(required=False)
    if user is None:
        return jsonify(success=True, profile=None, needs_login=True, players=_players(),
                       desktop=bool(current_app.config.get("LIST_PLAYERS")))
    active = user.games.filter_by(status="active").order_by(Game.id.desc()).first()
    return jsonify(success=True, profile=svc.profile(user), active_game=active.id if active else None,
                   desktop=bool(current_app.config.get("LIST_PLAYERS")))


@bp.post("/tutorial/done")
def tutorial_done():
    user = current_user()
    user.tutorial_done = True
    db.session.commit()
    return jsonify(success=True, profile=svc.profile(user))


@bp.post("/settings")
def settings():
    user = current_user()
    theme = body().get("theme")
    if theme in THEMES:
        user.theme = theme
        db.session.commit()
    return jsonify(success=True, profile=svc.profile(user))


# ----------------------------------------------------------- catalogue ----
@bp.get("/modes")
def modes():
    return jsonify(success=True, modes=[m.to_dict() for m in MODES.values()])


@bp.get("/packs")
def packs():
    return jsonify(success=True, packs=svc.list_packs(current_user()))


@bp.get("/packs/<pack_id>/levels")
def pack_levels(pack_id):
    if pack_id not in PACK_BY_ID:
        return err("Unknown pack.", 404)
    return jsonify(success=True, pack=PACK_BY_ID[pack_id], levels=svc.list_levels(current_user(), pack_id))


@bp.get("/daily")
def daily():
    return jsonify(success=True, daily=svc.daily_info(current_user()))


# --------------------------------------------------------------- games ----
@bp.post("/games")
def start():
    data = body()
    user = current_user()
    try:
        game = svc.start_game(user, data.get("mode", "classic"), data.get("pack"), data.get("level"))
    except PermissionError as e:
        return err(str(e), 403)
    except ValueError as e:
        return err(str(e))
    return game_payload(user, game, adaptive=svc.adaptive_report(user)["next"])


@bp.get("/games/<int:game_id>")
def get_game(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    return game_payload(user, game)


def _pos(v):
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise ValueError
    return int(v[0]), int(v[1])


@bp.post("/games/<int:game_id>/move")
def move(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    data = body()
    try:
        a, b = _pos(data.get("a")), _pos(data.get("b"))
    except (TypeError, ValueError):
        return err("Invalid move positions.")
    state = game.state
    before = [list(r) for r in state["grid"]]
    event = S.play_move(state, a, b)
    game.set_state(state)
    if event.get("valid") is not None:
        svc.record_move(game, before, a, b, event)
    new_ach = svc.move_achievements(user, state) if event.get("valid") else []
    return game_payload(user, game, event=event, new_achievements=new_ach)


@bp.post("/games/<int:game_id>/undo")
def undo(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    state = game.state
    event = S.undo(state)
    game.set_state(state)
    return game_payload(user, game, event=event)


@bp.post("/games/<int:game_id>/hint")
def hint(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    state = game.state
    event = S.use_hint(state, body().get("level", 1))
    game.set_state(state)
    return game_payload(user, game, event=event)


@bp.post("/games/<int:game_id>/solve")
def solve_game(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    state = game.state
    if not S.config(state).solver_allowed:
        return err("The solver is disabled in this mode.", 403)
    reveal = bool(body().get("reveal"))
    analysis = S.analyse(state, reveal=reveal)
    m = measure(state["grid"], state["frozen"], rollouts=12, solve_result=None, budget=4000)
    analysis["estimated_difficulty"] = m["difficulty"].title()
    analysis["metrics"] = m
    game.set_state(state)
    return game_payload(user, game, analysis=analysis)


@bp.post("/games/<int:game_id>/item")
def item(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    item_id = body().get("item")
    if (user.inventory or {}).get(item_id, 0) <= 0:
        return err("You don't own that item - visit the store.")
    state = game.state
    event = S.use_item(state, item_id)
    if event.get("success"):
        svc.consume_item(user, item_id)
    game.set_state(state)
    return game_payload(user, game, event=event)


@bp.post("/games/<int:game_id>/end")
def end(game_id):
    user = current_user()
    game = game_or_404(user, game_id)
    if not game:
        return err("Game not found.", 404)
    state = game.state
    S.abandon(state)
    game.set_state(state)
    return game_payload(user, game)


# ----------------------------------------------------------- solver lab ----
@bp.post("/solver")
def solver_lab():
    data = body()
    try:
        grid = parse_grid_text(data.get("board", ""))
    except ValueError as e:
        return err(str(e))
    frozen = [tuple(p) for p in data.get("frozen", [])]
    res = solve(grid, frozen, budget=40_000)
    m = measure(grid, frozen, rollouts=16, solve_result=res)
    return jsonify(success=True, grid=grid, frozen=[list(p) for p in frozen], result=res.to_dict(),
                   metrics=m, estimated_difficulty=m["difficulty"].title())


# --------------------------------------------------------- progression ----
@bp.get("/stats")
def stats():
    return jsonify(success=True, **svc.analytics(current_user()))


@bp.get("/achievements")
def achievements():
    return jsonify(success=True, **svc.achievements_for(current_user()))


@bp.get("/skill")
def skill():
    return jsonify(success=True, **svc.adaptive_report(current_user()))


@bp.get("/leaderboard")
def leaderboard():
    period = request.args.get("period", "all")
    if period not in ("daily", "weekly", "all"):
        period = "all"
    user = current_user()
    return jsonify(success=True, period=period, rows=svc.leaderboard(period), you=user.id,
                   daily=svc.daily_leaderboard(svc.today_utc()))


# ----------------------------------------------------------------- shop ----
@bp.get("/shop")
def shop():
    user = current_user()
    return jsonify(success=True, items=svc.SHOP_ITEMS, coins=user.coins, inventory=user.inventory or {})


@bp.post("/shop/buy")
def shop_buy():
    user = current_user()
    ok, message = svc.buy(user, body().get("item"))
    if not ok:
        return err(message, coins=user.coins)
    return jsonify(success=True, message=message, coins=user.coins, inventory=user.inventory,
                   profile=svc.profile(user))
