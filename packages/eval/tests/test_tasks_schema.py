"""Validate the v1 task JSON file parses correctly and meets schema constraints."""

from __future__ import annotations

from pathlib import Path

import pytest

from geochatbot_eval.tasks import Task, load_tasks

# Resolve path relative to this test file
_TASKS_FILE = Path(__file__).parent.parent / "tasks" / "nyc_311_v1.json"


@pytest.fixture(scope="module")
def tasks() -> list[Task]:
    return load_tasks(_TASKS_FILE)


def test_tasks_load(tasks):
    """File parses without error."""
    assert len(tasks) > 0


def test_task_count(tasks):
    """Should have exactly 8 tasks."""
    assert len(tasks) == 8


def test_unique_ids(tasks):
    """All task IDs must be unique."""
    ids = [t.id for t in tasks]
    assert len(ids) == len(set(ids)), f"Duplicate IDs found: {ids}"


def test_expected_ids(tasks):
    """Check all required task IDs are present."""
    expected_ids = {
        "count_total",
        "top_borough",
        "requests_per_borough",
        "requests_in_brooklyn",
        "top_complaint_type",
        "points_within_buffer",
        "request_density_map",
        "summary_stats",
    }
    found_ids = {t.id for t in tasks}
    assert found_ids == expected_ids, f"Missing IDs: {expected_ids - found_ids}"


def test_each_task_has_question(tasks):
    for t in tasks:
        assert t.question.strip(), f"Task {t.id} has empty question"


def test_each_task_has_dataset_refs(tasks):
    for t in tasks:
        assert t.dataset_refs, f"Task {t.id} has no dataset_refs"


def test_each_task_has_acceptable_plan_shapes(tasks):
    for t in tasks:
        assert t.acceptable_plan_shapes, f"Task {t.id} has no acceptable_plan_shapes"
        for shape in t.acceptable_plan_shapes:
            assert len(shape) >= 1, f"Task {t.id} has an empty shape"


def test_each_task_last_shape_step_is_render(tasks):
    """Every task must have at least one acceptable shape whose last step is a render.* tool."""
    for t in tasks:
        has_render_tail = any(
            shape[-1].get("tool", "").startswith("render.")
            for shape in t.acceptable_plan_shapes
            if shape
        )
        assert has_render_tail, (
            f"Task {t.id} has no acceptable shape ending in render.*"
        )


def test_expected_kinds_are_valid(tasks):
    valid_kinds = {"numeric", "geometry", "text"}
    for t in tasks:
        assert t.expected["kind"] in valid_kinds, (
            f"Task {t.id} has unknown expected kind: {t.expected['kind']!r}"
        )


def test_numeric_tasks_have_tolerance(tasks):
    for t in tasks:
        if t.expected["kind"] == "numeric":
            assert "tolerance" in t.expected, f"Task {t.id} missing tolerance"
            assert t.expected["tolerance"] >= 0


def test_text_tasks_have_must_contain(tasks):
    for t in tasks:
        if t.expected["kind"] == "text":
            assert t.expected.get("must_contain"), f"Task {t.id} must_contain is empty"
