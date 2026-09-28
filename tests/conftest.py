import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


@pytest.fixture()
def app(tmp_path):
    from app import create_app
    app = create_app({"TESTING": True, "SECRET_KEY": "test",
                      "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'test.db'}"})
    yield app


_counter = [0]


def new_player(app_or_client, name=None, pin=""):
    """A test client logged in as a brand-new player."""
    c = app_or_client.test_client() if hasattr(app_or_client, "test_client") else app_or_client
    _counter[0] += 1
    r = c.post("/api/auth/register", json={"username": name or f"Player{_counter[0]}", "password": pin})
    assert r.status_code == 200, r.get_json()
    return c


@pytest.fixture()
def client(app):
    return new_player(app)


@pytest.fixture()
def desktop_app(tmp_path):
    from app import create_app
    return create_app({"TESTING": True, "SECRET_KEY": "test", "REMEMBER_LAST_PLAYER": True, "LIST_PLAYERS": True,
                       "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'desk.db'}"})


def play_to_end(client, game_id, game, max_moves=120):
    """Drive a game with the solver's best move until it ends."""
    from engine.solver import best_move
    resp = None
    for _ in range(max_moves):
        if game["status"] != "active" or game.get("stuck"):
            break
        move, _, _ = best_move(game["grid"], game["frozen"], budget=3000)
        if move is None:
            break
        resp = client.post(f"/api/games/{game_id}/move", json={"a": list(move[0]), "b": list(move[1])}).get_json()
        game = resp["game"]
    return game, resp
