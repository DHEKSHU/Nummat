"""The Android app runs a JavaScript port of the engine (mobile/src/engine.js).
This test feeds the same random boards to both engines and checks every result
matches: pairs, moves with power-ups / frozen tiles / collapsing rows, "+", the
solver and move explanations. Skipped when Node.js isn't installed."""
import json
import os
import random
import shutil
import subprocess

import pytest

from engine.hints import explain_move
from engine.rules import add_rows, apply_move_detailed, find_pairs
from engine.solver import solve

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_python_and_js_engines_agree(tmp_path):
    rng = random.Random(5)
    cases = []
    for _ in range(300):
        R, C = rng.randint(2, 6), rng.randint(2, 6)
        g = [[rng.choice([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, -1, 105, 207, 3, 7]) for _ in range(C)] for _ in range(R)]
        fr = [(r, c) for r in range(R) for c in range(C) if g[r][c] > 0 and rng.random() < 0.1]
        col = rng.random() < 0.5
        pairs = find_pairs(g, fr)
        case = {"g": g, "f": [list(p) for p in fr], "collapse": col, "pairs": [[list(a), list(b), k] for a, b, k in pairs]}
        if pairs:
            a, b, k = rng.choice(pairs)
            d = apply_move_detailed(g, fr, a, b, col)
            case["move"] = [list(a), list(b)]
            case["out"] = {"grid": d["grid"], "frozen": sorted([list(p) for p in d["frozen"]]),
                           "cleared": sorted([list(p) for p in d["cleared"]]), "powers": [t for t, _ in d["powers"]],
                           "rows_removed": d["rows_removed"]}
            ex = explain_move(g, fr, a, b, k, 0, 1, 0, col)
            case["unlocked"] = sorted([sorted([list(x), list(y)]) for x, y in ex["unlocked"]])
            case["delta"] = ex["difficulty_impact"]
        ar = add_rows(g)
        case["add"] = [ar[0], [list(p) for p in ar[1]]] if ar else None
        if R * C <= 16:
            case["solve"] = solve(g, fr, budget=3000, collapse=col).solvable
        cases.append(case)
    path = tmp_path / "cases.json"
    path.write_text(json.dumps(cases))
    out = subprocess.run(["node", os.path.join(ROOT, "mobile", "tests", "parity.js"), str(path)],
                         capture_output=True, text=True, timeout=300)
    assert "PARITY OK" in out.stdout, out.stdout + out.stderr
