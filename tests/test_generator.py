"""Level generation pipeline."""
import pytest

from engine.generator import LevelSpec, classify, generate_level, inject_solvable_pair, validate
from engine.rules import find_pairs, tiles_left
from engine.solver import solve
import random


@pytest.mark.parametrize("seed", range(8))
@pytest.mark.parametrize("size", [4, 5, 6, 7])
def test_generated_boards_are_solvable(size, seed):
    level = generate_level(LevelSpec(rows=size, cols=size, fill=0.85), seed)
    assert tiles_left(level.grid) % 2 == 0
    assert level.metrics["solvable"] is True
    assert solve(level.grid, level.frozen, budget=50_000).solvable is not False


def test_boards_with_specials_are_solvable():
    for seed in range(5):
        lvl = generate_level(LevelSpec(rows=7, cols=7, fill=0.9, blocked=4, frozen=5, wild=1, target="EXPERT"), seed)
        ok, why = validate(lvl.grid, lvl.frozen)
        assert ok, why
        assert lvl.metrics["solvable"] is True
        assert sum(v == -1 for r in lvl.grid for v in r) == 5


def test_same_seed_same_board():
    spec = LevelSpec(rows=6, cols=7, fill=1.0, blocked=2, target="HARD")
    assert generate_level(spec, 20260927).grid == generate_level(spec, 20260927).grid
    assert generate_level(spec, 20260927).grid != generate_level(spec, 20260928).grid


def test_metrics_present_and_classified():
    lvl = generate_level(LevelSpec(rows=5, cols=5), 1)
    for key in ("tiles", "valid_pairs", "first_moves", "min_moves", "avg_solution_depth",
                "deadlock_probability", "branching_factor"):
        assert key in lvl.metrics
    assert lvl.difficulty in ("EASY", "MEDIUM", "HARD", "EXPERT")
    assert classify(5) == "EASY" and classify(99) == "EXPERT"


def test_bigger_boards_are_harder_on_average():
    small = sum(generate_level(LevelSpec(rows=4, cols=4), s).difficulty_score for s in range(5))
    big = sum(generate_level(LevelSpec(rows=8, cols=8), s).difficulty_score for s in range(5))
    assert big > small


def test_validation_rejects_bad_boards():
    assert not validate([[1, 2, 3]], [])[0]          # odd
    assert not validate([[1, 2], [3, 4]], [])[0]     # unpairable


def test_injected_pair_is_immediately_matchable():
    g = [[0, 0, 0], [0, 0, 0]]
    placed = inject_solvable_pair(g, random.Random(1))
    assert placed and find_pairs(g)


@pytest.mark.parametrize("dims", [(4, 4), (4, 5), (5, 6), (6, 6), (6, 7), (7, 8), (8, 8)])
def test_boards_are_completely_filled(dims):
    for seed in range(5):
        lvl = generate_level(LevelSpec(rows=dims[0], cols=dims[1]), seed)
        assert all(v != 0 for row in lvl.grid for v in row), "board has empty cells"


def test_every_mode_starts_full():
    from engine.modes import MODES, spec_for, PACKS
    specs = [spec_for(m, 5.0) for m in MODES] + [spec_for("classic", 5.0, p["id"], i) for p in PACKS for i in (1, 5, 13)]
    for i, spec in enumerate(specs):
        lvl = generate_level(spec, i)
        assert all(v != 0 for row in lvl.grid for v in row), (spec, lvl.grid)
