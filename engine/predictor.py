"""
Difficulty predictor (optional, "phase 2")
=========================================

A tiny ridge-regression model - pure Python, no numpy - that learns from
recorded games to predict how well a player will do on their next game:

    features (rolling window of previous games)          target
    ─────────────────────────────────────────           ──────────────────────
    avg_solve_time, mistakes, hints_used,        ──►     next game's game_skill (0-10)
    undo_count, streak, level_completion_rate

The prediction is blended into the heuristic skill (30 %) by
engine.difficulty.skill_from_history once a model has been trained on enough
data. Train it with:

    python scripts/train_model.py

Until then NUMMAT uses the heuristic engine only.
"""
from __future__ import annotations

import json
import os
from typing import Dict, List, Optional, Sequence, Tuple

from .difficulty import game_skill

FEATURES = ["avg_solve_time", "mistakes", "hints_used", "undo_count", "streak", "level_completion_rate"]
MIN_SAMPLES = 30
LOOKBACK = 5


def features_from_games(games: Sequence[Dict]) -> List[float]:
    g = list(games)[-LOOKBACK:]
    n = max(1, len(g))
    matches = [max(1, x.get("attempts", 0) - x.get("mistakes", 0)) for x in g]
    return [
        sum(x.get("duration", 0) / m for x, m in zip(g, matches)) / n,     # sec per pair
        sum(x.get("mistakes", 0) for x in g) / n,
        sum(x.get("hints_used", 0) for x in g) / n,
        sum(x.get("undos_used", 0) for x in g) / n,
        sum(x.get("max_streak", 0) for x in g) / n,
        sum(1 for x in g if x.get("won")) / n,
    ]


def build_dataset(histories: Dict[int, Sequence[Dict]]) -> Tuple[List[List[float]], List[float]]:
    """From {user_id: [games oldest->newest]} build (X, y) pairs."""
    X, y = [], []
    for games in histories.values():
        games = list(games)
        for i in range(2, len(games)):
            X.append(features_from_games(games[:i]))
            y.append(game_skill(games[i]))
    return X, y


def _solve_linear(A: List[List[float]], b: List[float]) -> List[float]:
    """Gaussian elimination with partial pivoting."""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        if abs(M[col][col]) < 1e-12:
            continue
        for r in range(n):
            if r != col:
                f = M[r][col] / M[col][col]
                for c in range(col, n + 1):
                    M[r][c] -= f * M[col][c]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


class DifficultyModel:
    def __init__(self, weights: Optional[List[float]] = None, means=None, stds=None, n: int = 0, mae: float = 0.0):
        self.weights = weights
        self.means = means
        self.stds = stds
        self.n = n
        self.mae = mae

    @property
    def ready(self) -> bool:
        return self.weights is not None and self.n >= MIN_SAMPLES

    def fit(self, X: List[List[float]], y: List[float], l2: float = 1.0) -> "DifficultyModel":
        if not X:
            return self
        k = len(X[0])
        self.means = [sum(r[j] for r in X) / len(X) for j in range(k)]
        self.stds = [max(1e-6, (sum((r[j] - self.means[j]) ** 2 for r in X) / len(X)) ** 0.5) for j in range(k)]
        Z = [[1.0] + [(r[j] - self.means[j]) / self.stds[j] for j in range(k)] for r in X]
        d = k + 1
        A = [[sum(z[i] * z[j] for z in Z) + (l2 if i == j and i > 0 else 0.0) for j in range(d)] for i in range(d)]
        b = [sum(z[i] * t for z, t in zip(Z, y)) for i in range(d)]
        self.weights = _solve_linear(A, b)
        self.n = len(X)
        self.mae = sum(abs(self._raw(r) - t) for r, t in zip(X, y)) / len(X)
        return self

    def _raw(self, x: List[float]) -> float:
        z = [1.0] + [(x[j] - self.means[j]) / self.stds[j] for j in range(len(x))]
        return sum(w * v for w, v in zip(self.weights, z))

    def predict(self, x: List[float]) -> Optional[float]:
        if not self.ready:
            return None
        return max(0.0, min(10.0, self._raw(x)))

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"features": FEATURES, "weights": self.weights, "means": self.means,
                       "stds": self.stds, "n": self.n, "mae": self.mae}, f, indent=2)

    @classmethod
    def load(cls, path: str) -> "DifficultyModel":
        if not os.path.exists(path):
            return cls()
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            return cls(d["weights"], d["means"], d["stds"], d.get("n", 0), d.get("mae", 0.0))
        except (OSError, ValueError, KeyError):
            return cls()
