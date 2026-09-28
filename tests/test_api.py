"""REST API end-to-end: accounts, games, persistence, leaderboards, shop."""
from conftest import new_player, play_to_end


def test_nobody_logged_in_asks_for_a_player(app):
    c = app.test_client()
    r = c.get("/api/me").get_json()
    assert r["needs_login"] and r["profile"] is None
    assert c.get("/api/stats").status_code == 401          # no silent "Guest 17" any more


def test_single_reusable_guest(app):
    a, b = app.test_client(), app.test_client()
    ga = a.post("/api/auth/guest").get_json()["profile"]
    gb = b.post("/api/auth/guest").get_json()["profile"]
    assert ga["id"] == gb["id"] and ga["username"] == "Guest" and ga["coins"] == 100


def test_play_pack_level_and_progress_saves(client):
    r = client.post("/api/games", json={"mode": "classic", "pack": "default", "level": 1}).get_json()
    assert r["success"]
    game, last = play_to_end(client, r["game_id"], r["game"])
    assert game["status"] == "won"
    result = last["result"]
    assert result["coins_earned"] > 0 and result["first_clear"]
    levels = client.get("/api/packs/default/levels").get_json()["levels"]
    assert levels[0]["completed"] and not levels[1]["locked"] and levels[2]["locked"]
    stats = client.get("/api/stats").get_json()
    assert stats["table"]["levels_completed"] == 1 and stats["table"]["total_matches"] == game["matches"]


def test_locked_level_rejected(client):
    r = client.post("/api/games", json={"mode": "classic", "pack": "default", "level": 5})
    assert r.status_code == 403
    r = client.post("/api/games", json={"mode": "classic", "pack": "autumn", "level": 1})
    assert r.status_code == 403


def test_register_keeps_guest_progress_and_login(app):
    client = app.test_client()
    client.post("/api/auth/guest")
    client.post("/api/shop/buy", json={"item": "shuffle"})
    r = client.post("/api/auth/register", json={"username": "Dhekshitha", "password": "secret1"}).get_json()
    assert r["success"] and r["profile"]["username"] == "Dhekshitha"
    assert r["profile"]["inventory"]["shuffle"] == 2 and r["profile"]["coins"] == 0
    client.post("/api/auth/logout")
    assert client.get("/api/me").get_json()["needs_login"]
    bad = client.post("/api/auth/login", json={"username": "dhekshitha", "password": "nope"})
    assert bad.status_code == 401
    ok = client.post("/api/auth/login", json={"username": "dhekshitha", "password": "secret1"}).get_json()
    assert ok["profile"]["coins"] == 0
    dup = client.post("/api/auth/register", json={"username": "Dhekshitha", "password": "secret2"})
    assert dup.status_code == 400
    # the next guest is a fresh profile
    g = app.test_client().post("/api/auth/guest").get_json()["profile"]
    assert g["is_guest"] and g["coins"] == 100


def test_daily_is_same_for_everyone(app):
    a, b = new_player(app), new_player(app)
    ga = a.post("/api/games", json={"mode": "daily"}).get_json()["game"]
    gb = b.post("/api/games", json={"mode": "daily"}).get_json()["game"]
    assert ga["grid"] == gb["grid"] and ga["seed"] == gb["seed"]
    assert a.post(f"/api/games/{1}/hint", json={"level": 1}).get_json()["event"]["success"] is False


def test_leaderboard_and_daily_board(client):
    r = client.post("/api/games", json={"mode": "daily"}).get_json()
    play_to_end(client, r["game_id"], r["game"])
    board = client.get("/api/leaderboard?period=daily").get_json()
    assert board["rows"] and board["rows"][0]["score"] > 0
    assert board["daily"] and board["daily"][0]["rank"] == 1


def test_games_are_isolated_between_players(app):
    a, b = new_player(app), new_player(app)
    gid = a.post("/api/games", json={"mode": "zen"}).get_json()["game_id"]
    assert b.get(f"/api/games/{gid}").status_code == 404


def test_solver_endpoint(client):
    r = client.post("/api/solver", json={"board": "1 9 5 5\n3 3 2 8"}).get_json()
    assert r["result"]["solvable"] is True and r["result"]["moves_to_clear"] == 4
    bad = client.post("/api/solver", json={"board": "1 2 x9"})
    assert bad.status_code == 400


def test_shop_requires_coins(client):
    assert client.post("/api/shop/buy", json={"item": "double_coins"}).status_code == 400
    assert client.post("/api/shop/buy", json={"item": "shuffle"}).get_json()["success"]


def test_items_disabled_in_daily(client):
    gid = client.post("/api/games", json={"mode": "daily"}).get_json()["game_id"]
    r = client.post(f"/api/games/{gid}/item", json={"item": "shuffle"}).get_json()
    assert r["event"]["success"] is False


def test_moves_are_recorded(app, client):
    from models import Move
    r = client.post("/api/games", json={"mode": "zen"}).get_json()
    play_to_end(client, r["game_id"], r["game"], max_moves=3)
    client.post(f"/api/games/{r['game_id']}/move", json={"a": [0, 0], "b": [0, 0]})
    with app.app_context():
        moves = Move.query.filter_by(game_id=r["game_id"]).all()
        assert len(moves) == 4 and moves[-1].valid is False


def test_pin_is_optional_and_checked(app):
    c = app.test_client()
    assert c.post("/api/auth/register", json={"username": "No Pin"}).status_code == 200
    c.post("/api/auth/logout")
    assert c.post("/api/auth/login", json={"username": "no pin"}).status_code == 200      # no PIN needed
    c.post("/api/auth/register", json={"username": "Asha", "password": "4321"})
    c.post("/api/auth/logout")
    assert c.post("/api/auth/login", json={"username": "Asha", "password": "0000"}).status_code == 401
    assert c.post("/api/auth/login", json={"username": "Asha", "password": "4321"}).status_code == 200
    assert c.post("/api/auth/register", json={"username": "X", "password": ""}).status_code == 400   # too short
    assert c.post("/api/auth/register", json={"username": "Bad", "password": "12"}).status_code == 400


def test_tutorial_flag(client):
    assert client.get("/api/me").get_json()["profile"]["tutorial_done"] is False
    client.post("/api/tutorial/done")
    assert client.get("/api/me").get_json()["profile"]["tutorial_done"] is True


def test_desktop_mode_remembers_last_player(desktop_app):
    c = desktop_app.test_client()
    c.post("/api/auth/register", json={"username": "Dhekshitha"})
    # a brand-new window (no cookies) is logged straight back in
    fresh = desktop_app.test_client()
    me = fresh.get("/api/me").get_json()
    assert me["profile"]["username"] == "Dhekshitha"
    # switching player forgets it and lists local players
    out = fresh.post("/api/auth/logout").get_json()
    assert out["needs_login"] and out["players"][0]["name"] == "Dhekshitha"
    assert desktop_app.test_client().get("/api/me").get_json()["needs_login"]
    # pick from the list by id
    r = desktop_app.test_client().post("/api/auth/login", json={"user_id": out["players"][0]["id"]}).get_json()
    assert r["success"]


def test_players_hidden_in_web_mode(app):
    new_player(app, "Someone")
    assert app.test_client().get("/api/players").get_json()["players"] == []
