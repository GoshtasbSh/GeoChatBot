"""Unit tests for geochatbot_eval.leaderboard."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from geochatbot_eval.leaderboard import render_leaderboard


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_run_file(records: list[dict], tmp_dir: Path) -> Path:
    p = tmp_dir / "run.json"
    p.write_text(json.dumps(records), encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# Empty runs → placeholder
# ---------------------------------------------------------------------------

def test_no_runs_placeholder():
    """render_leaderboard with no run files returns a 'No runs yet' placeholder."""
    md = render_leaderboard([])
    assert "No runs yet" in md
    assert "packages/eval/README.md" in md


def test_empty_run_file_placeholder(tmp_path):
    """A run file that exists but is empty returns placeholder."""
    empty = tmp_path / "empty.json"
    empty.write_text("", encoding="utf-8")
    md = render_leaderboard([empty])
    assert "No runs yet" in md


# ---------------------------------------------------------------------------
# One synthetic run → renders the table
# ---------------------------------------------------------------------------

def _synthetic_records() -> list[dict]:
    return [
        {
            "model": "claude-sonnet-4-6",
            "task_id": "count_total",
            "passed": True,
            "plan_pass": True,
            "answer_pass": True,
            "latency_ms": 3200.0,
            "error": None,
        },
        {
            "model": "claude-sonnet-4-6",
            "task_id": "top_borough",
            "passed": True,
            "plan_pass": True,
            "answer_pass": True,
            "latency_ms": 2800.0,
            "error": None,
        },
        {
            "model": "claude-sonnet-4-6",
            "task_id": "requests_in_brooklyn",
            "passed": False,
            "plan_pass": True,
            "answer_pass": False,
            "latency_ms": 4100.0,
            "error": "numeric extraction failed",
        },
    ]


def test_one_model_renders_table(tmp_path):
    records = _synthetic_records()
    run_file = _write_run_file(records, tmp_path)
    md = render_leaderboard([run_file])
    assert "claude-sonnet-4-6" in md
    assert "| Model |" in md
    assert "Pass rate" in md


def test_pass_rate_correct(tmp_path):
    records = _synthetic_records()
    run_file = _write_run_file(records, tmp_path)
    md = render_leaderboard([run_file])
    # 2 out of 3 tasks passed → "2/3"
    assert "2/3" in md


def test_per_task_breakdown_present(tmp_path):
    records = _synthetic_records()
    run_file = _write_run_file(records, tmp_path)
    md = render_leaderboard([run_file])
    assert "Per-task breakdown" in md
    assert "count_total" in md
    assert "top_borough" in md
    assert "requests_in_brooklyn" in md


def test_pass_fail_markers(tmp_path):
    records = _synthetic_records()
    run_file = _write_run_file(records, tmp_path)
    md = render_leaderboard([run_file])
    # OK and FAIL should appear for passing and failing tasks
    assert "OK" in md
    assert "FAIL" in md


def test_two_models_separate_rows(tmp_path):
    records = _synthetic_records() + [
        {
            "model": "claude-haiku-4-5-20251001",
            "task_id": "count_total",
            "passed": True,
            "plan_pass": True,
            "answer_pass": True,
            "latency_ms": 1500.0,
            "error": None,
        },
        {
            "model": "claude-haiku-4-5-20251001",
            "task_id": "top_borough",
            "passed": False,
            "plan_pass": False,
            "answer_pass": False,
            "latency_ms": 1200.0,
            "error": None,
        },
    ]
    run_file = _write_run_file(records, tmp_path)
    md = render_leaderboard([run_file])
    assert "claude-sonnet-4-6" in md
    assert "claude-haiku-4-5-20251001" in md
    # Both models should appear as separate rows in the summary table.
    # Summary rows start with "| claude-" (not "| Task |" or "| Model |").
    lines = [l for l in md.splitlines() if l.startswith("| claude-")]
    assert len(lines) == 2, f"Expected 2 model rows, got {len(lines)}: {lines}"


def test_latency_rendered(tmp_path):
    records = _synthetic_records()
    run_file = _write_run_file(records, tmp_path)
    md = render_leaderboard([run_file])
    # Mean of 3200, 2800, 4100 ms = 3366.7 ms = ~3.4s
    assert "s" in md  # latency column has 's' suffix
