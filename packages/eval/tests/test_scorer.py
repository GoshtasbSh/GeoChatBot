"""Unit tests for geochatbot_eval.scorer."""

from __future__ import annotations

import pytest

from geochatbot_eval.scorer import (
    ScoreResult,
    plan_pass,
    score_numeric,
    score_task,
    score_text,
    shape_matches,
)
from geochatbot_eval.tasks import (
    NumericExpected,
    StepShape,
    Task,
    TextExpected,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_task(
    shapes: list[list[StepShape]],
    expected: dict,
) -> Task:
    from geochatbot_eval.tasks import _parse_expected
    return Task(
        id="test",
        question="test question",
        dataset_refs=["nyc311"],
        acceptable_plan_shapes=shapes,
        expected=_parse_expected(expected),
    )


# ---------------------------------------------------------------------------
# 1. plan-shape match passes when every step matches in order
# ---------------------------------------------------------------------------

def test_shape_matches_all_steps_in_order():
    shape: list[StepShape] = [{"tool": "sql"}, {"tool": "render.summary"}]
    actual = [
        {"tool": "sql", "args": {}},
        {"tool": "render.summary", "args": {}},
    ]
    assert shape_matches(shape, actual) is True


# ---------------------------------------------------------------------------
# 2. plan-shape match fails when an extra step is inserted BETWEEN required steps
#    (shape uses ordered subsequence matching, so an extra step at the END is OK,
#     but a required step that never appears fails)
# ---------------------------------------------------------------------------

def test_shape_fails_when_required_tool_absent():
    """If the shape requires 'render.map' but the plan has no such step, fail."""
    shape: list[StepShape] = [{"tool": "sql"}, {"tool": "render.map"}]
    actual = [
        {"tool": "sql", "args": {}},
        {"tool": "render.summary", "args": {}},  # wrong tool
    ]
    assert shape_matches(shape, actual) is False


# ---------------------------------------------------------------------------
# 3. plan-shape match passes when args_contains is a subset of actual args
# ---------------------------------------------------------------------------

def test_shape_args_contains_subset_passes():
    shape: list[StepShape] = [
        {"tool": "sql", "args_contains": {"query": "brooklyn"}}
    ]
    actual = [
        {"tool": "sql", "args": {"query": "SELECT * FROM nyc311 WHERE borough = 'Brooklyn'"}}
    ]
    assert shape_matches(shape, actual) is True


# ---------------------------------------------------------------------------
# 4. numeric expected passes within tolerance
# ---------------------------------------------------------------------------

def test_numeric_passes_within_tolerance():
    exp: NumericExpected = {"kind": "numeric", "value": 50.0, "tolerance": 5.0}
    passed, got = score_numeric(exp, "There are 52 total requests.")
    assert passed is True
    assert got == 52.0


# ---------------------------------------------------------------------------
# 5. numeric expected fails outside tolerance
# ---------------------------------------------------------------------------

def test_numeric_fails_outside_tolerance():
    exp: NumericExpected = {"kind": "numeric", "value": 50.0, "tolerance": 5.0}
    passed, got = score_numeric(exp, "Found 100 requests")
    assert passed is False
    assert got == 100.0


# ---------------------------------------------------------------------------
# 6. text expected fails when one must_contain string is missing
# ---------------------------------------------------------------------------

def test_text_fails_when_string_missing():
    exp: TextExpected = {"kind": "text", "must_contain": ["brooklyn", "queens"]}
    passed, missing = score_text(exp, "The answer is Brooklyn.")
    assert passed is False
    assert "queens" in missing


# ---------------------------------------------------------------------------
# Bonus 7. shape match passes if ANY of the acceptable shapes matches
# ---------------------------------------------------------------------------

def test_plan_pass_any_shape():
    """plan_pass returns True if at least one acceptable shape matches."""
    task = make_task(
        shapes=[
            [{"tool": "render.map"}],            # shape A — won't match
            [{"tool": "sql"}, {"tool": "render.summary"}],  # shape B — will match
        ],
        expected={"kind": "numeric", "value": 50.0, "tolerance": 5.0},
    )
    actual = [
        {"tool": "sql", "args": {}},
        {"tool": "render.summary", "args": {}},
    ]
    assert plan_pass(task, actual) is True


# ---------------------------------------------------------------------------
# Extra edge cases
# ---------------------------------------------------------------------------

def test_numeric_no_number_in_text():
    exp: NumericExpected = {"kind": "numeric", "value": 50.0, "tolerance": 5.0}
    passed, got = score_numeric(exp, "No numbers here at all.")
    assert passed is False
    assert got is None


def test_text_passes_case_insensitive():
    exp: TextExpected = {"kind": "text", "must_contain": ["Brooklyn", "Queens"]}
    passed, missing = score_text(exp, "brooklyn has 15 requests, queens has 10.")
    assert passed is True
    assert missing == []


def test_empty_shape_always_passes():
    """An empty shape list matches anything (no constraints)."""
    assert shape_matches([], [{"tool": "sql"}]) is True


def test_shape_subsequence_allows_extra_steps():
    """Extra steps in the plan are fine as long as the required tools appear in order."""
    shape: list[StepShape] = [{"tool": "sql"}, {"tool": "render.map"}]
    actual = [
        {"tool": "validate"},
        {"tool": "sql", "args": {}},
        {"tool": "geometry.buffer", "args": {}},
        {"tool": "render.map", "args": {}},
    ]
    assert shape_matches(shape, actual) is True


def test_score_task_returns_score_result():
    task = make_task(
        shapes=[[{"tool": "sql"}, {"tool": "render.summary"}]],
        expected={"kind": "numeric", "value": 50.0, "tolerance": 5.0},
    )
    result = score_task(
        task,
        actual_steps=[{"tool": "sql"}, {"tool": "render.summary"}],
        result_text="50 requests found",
    )
    assert isinstance(result, ScoreResult)
    assert result.task_id == "test"
    assert result.plan_pass is True
    assert result.answer_pass is True
    assert result.passed is True
