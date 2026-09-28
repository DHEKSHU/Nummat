"""
Train the optional difficulty predictor from recorded games.

    python scripts/train_model.py

Writes instance/difficulty_model.json. Once at least engine.predictor.MIN_SAMPLES
training samples exist, the adaptive engine blends the model's prediction
(30 %) into each player's skill after every game.
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import create_app  # noqa: E402
from engine.predictor import FEATURES, MIN_SAMPLES, DifficultyModel, build_dataset  # noqa: E402
from models import Game, User  # noqa: E402


def main() -> None:
    app = create_app()
    with app.app_context():
        histories = {}
        for user in User.query.all():
            games = (Game.query.filter(Game.user_id == user.id, Game.finalized.is_(True),
                                       Game.status != "abandoned", Game.mode != "zen")
                     .order_by(Game.ended_at).all())
            histories[user.id] = [g.summary() for g in games]
        X, y = build_dataset(histories)
        print(f"{len(X)} training samples from {len(histories)} players")
        if len(X) < MIN_SAMPLES:
            print(f"Need at least {MIN_SAMPLES} samples - keep playing! (heuristic engine stays in charge)")
            return
        model = DifficultyModel().fit(X, y)
        path = os.path.join(app.instance_path, "difficulty_model.json")
        model.save(path)
        print(f"Saved {path}  (train MAE {model.mae:.2f} skill points)")
        for name, w in zip(["bias"] + FEATURES, model.weights):
            print(f"  {name:>22}: {w:+.3f}")


if __name__ == "__main__":
    main()
