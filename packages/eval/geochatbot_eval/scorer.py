"""Scoring logic for GeoChatBot eval results."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .tasks import (
    ExpectedResult,
    GeometryExpected,
    NumericExpected,
    StepShape,
    Task,
    TextExpected,
)


# ---------------------------------------------------------------------------
# Plan-shape matching
# ---------------------------------------------------------------------------


def _args_contains_match(expected_args: dict, actual_args: dict | Any) -> bool:
    """Check that every key in expected_args is present in actual_args.

    - For strings: substring match (case-insensitive)
    - For numbers: equality
    - For lists: every expected item must appear in the actual list
    - For dicts: recursive subset match
    """
    if not isinstance(actual_args, dict):
        return False
    for key, exp_val in expected_args.items():
        if key not in actual_args:
            return False
        act_val = actual_args[key]
        if isinstance(exp_val, str):
            if exp_val.lower() not in str(act_val).lower():
                return False
        elif isinstance(exp_val, list):
            if not isinstance(act_val, list):
                return False
            for item in exp_val:
                if item not in act_val:
                    return False
        elif isinstance(exp_val, dict):
            if not _args_contains_match(exp_val, act_val):
                return False
        else:
            if exp_val != act_val:
                return False
    return True


def _step_matches(shape: StepShape, actual_step: dict) -> bool:
    """Check if a single step matches the given shape."""
    if "tool" in shape and shape["tool"] is not None:
        if actual_step.get("tool") != shape["tool"]:
            return False
    if "output_var" in shape and shape["output_var"] is not None:
        if actual_step.get("output_var") != shape["output_var"]:
            return False
    if "args_contains" in shape and shape["args_contains"] is not None:
        if not _args_contains_match(shape["args_contains"], actual_step.get("args", {})):
            return False
    return True


def shape_matches(shape: list[StepShape], actual_steps: list[dict]) -> bool:
    """Check if actual_steps matches a required plan shape.

    Each StepShape must match the corresponding step at the same index.
    The shape length must equal the actual steps length for a full match,
    OR the shape can be a prefix/subsequence — we use ordered subsequence matching
    so extra steps don't cause failure, but all shape positions must appear in order.
    """
    if not shape:
        return True

    # Walk actual steps, consuming shape positions in order
    shape_idx = 0
    for step in actual_steps:
        if shape_idx >= len(shape):
            break
        if _step_matches(shape[shape_idx], step):
            shape_idx += 1

    return shape_idx == len(shape)


def plan_pass(task: Task, actual_steps: list[dict]) -> bool:
    """Return True if at least one acceptable plan shape matches."""
    return any(shape_matches(shape, actual_steps) for shape in task.acceptable_plan_shapes)


# ---------------------------------------------------------------------------
# Answer scoring
# ---------------------------------------------------------------------------


def _extract_number(text: str) -> float | None:
    """Extract the first number from text using a regex."""
    # Look for standalone integers or decimals (not inside longer strings)
    matches = re.findall(r"\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b", text)
    if not matches:
        return None
    # Strip commas (thousands separator)
    return float(matches[0].replace(",", ""))


def score_numeric(expected: NumericExpected, result_text: str) -> tuple[bool, float | None]:
    """Score a numeric expected result. Returns (passed, extracted_value)."""
    got = _extract_number(result_text)
    if got is None:
        return False, None
    passed = abs(got - expected["value"]) <= expected["tolerance"]
    return passed, got


def score_geometry(
    expected: GeometryExpected, feature_count: int | None
) -> tuple[bool, int | None]:
    """Score a geometry expected result. Returns (passed, feature_count)."""
    if feature_count is None:
        return False, None
    passed = abs(feature_count - expected["feature_count"]) <= expected["feature_count_tolerance"]
    return passed, feature_count


def score_text(expected: TextExpected, result_text: str) -> tuple[bool, list[str]]:
    """Score a text expected result. Returns (passed, missing_strings)."""
    lower = result_text.lower()
    missing = [s for s in expected["must_contain"] if s.lower() not in lower]
    return len(missing) == 0, missing


# ---------------------------------------------------------------------------
# Unified score_task
# ---------------------------------------------------------------------------


@dataclass
class ScoreResult:
    task_id: str
    plan_pass: bool
    answer_pass: bool
    passed: bool  # plan_pass AND answer_pass
    detail: dict  # scorer-specific detail


def score_task(
    task: Task,
    actual_steps: list[dict],
    result_text: str,
    feature_count: int | None = None,
) -> ScoreResult:
    """Compute pass/fail for a single task run."""
    pp = plan_pass(task, actual_steps)

    exp = task.expected
    if exp["kind"] == "numeric":
        ap, detail_val = score_numeric(exp, result_text)  # type: ignore[arg-type]
        detail = {"extracted": detail_val}
    elif exp["kind"] == "geometry":
        ap, detail_val = score_geometry(exp, feature_count)  # type: ignore[arg-type]
        detail = {"feature_count": detail_val}
    elif exp["kind"] == "text":
        ap, missing = score_text(exp, result_text)  # type: ignore[arg-type]
        detail = {"missing": missing}
    else:
        ap = False
        detail = {"error": f"Unknown expected kind: {exp['kind']}"}

    return ScoreResult(
        task_id=task.id,
        plan_pass=pp,
        answer_pass=ap,
        passed=pp and ap,
        detail=detail,
    )
