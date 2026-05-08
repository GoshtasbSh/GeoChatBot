"""Task type definitions and loader for the GeoChatBot eval harness."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional, Union

from typing_extensions import TypedDict


class StepShape(TypedDict, total=False):
    """Partial matcher for a single plan step."""

    tool: str
    """Exact tool id, e.g. 'geometry.buffer'."""

    output_var: Optional[str]
    """Expected output variable name (optional)."""

    args_contains: Optional[dict]
    """Subset match on args (string contains for strings, == for numbers, list contains for lists)."""


class NumericExpected(TypedDict):
    """Expect a numeric value in the result."""

    kind: Literal["numeric"]
    value: float
    tolerance: float
    """Absolute tolerance; pass if abs(got - value) <= tolerance."""


class GeometryExpected(TypedDict):
    """Expect a GeoJSON feature collection in the result."""

    kind: Literal["geometry"]
    feature_count: int
    """Expected number of features."""
    feature_count_tolerance: int
    """Allowed deviation from feature_count (0 = exact)."""


class TextExpected(TypedDict):
    """Expect certain strings to appear in the result text."""

    kind: Literal["text"]
    must_contain: list[str]
    """All strings must appear (case-insensitive)."""


ExpectedResult = Union[NumericExpected, GeometryExpected, TextExpected]


@dataclass
class Task:
    """A single evaluation task."""

    id: str
    """Unique task identifier."""

    question: str
    """The plain-English question posed to the widget."""

    dataset_refs: list[str]
    """Names of datasets to push before running (e.g. ['nyc311', 'boroughs'])."""

    acceptable_plan_shapes: list[list[StepShape]]
    """Any one matching shape is sufficient. Each shape is an ordered list of partial step matchers."""

    expected: ExpectedResult
    """How to score the answer."""

    tags: list[str] = field(default_factory=list)
    """Optional metadata tags (e.g. 'spatial', 'aggregate', 'render')."""


def _parse_expected(raw: dict) -> ExpectedResult:
    kind = raw.get("kind")
    if kind == "numeric":
        return NumericExpected(
            kind="numeric",
            value=float(raw["value"]),
            tolerance=float(raw["tolerance"]),
        )
    elif kind == "geometry":
        return GeometryExpected(
            kind="geometry",
            feature_count=int(raw["feature_count"]),
            feature_count_tolerance=int(raw.get("feature_count_tolerance", 0)),
        )
    elif kind == "text":
        return TextExpected(
            kind="text",
            must_contain=list(raw["must_contain"]),
        )
    else:
        raise ValueError(f"Unknown expected kind: {kind!r}")


def _parse_task(raw: dict) -> Task:
    return Task(
        id=raw["id"],
        question=raw["question"],
        dataset_refs=list(raw["dataset_refs"]),
        acceptable_plan_shapes=[
            [StepShape(**s) for s in shape]
            for shape in raw["acceptable_plan_shapes"]
        ],
        expected=_parse_expected(raw["expected"]),
        tags=list(raw.get("tags", [])),
    )


def load_tasks(path: str | Path) -> list[Task]:
    """Load and validate tasks from a JSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise TypeError(f"Expected a JSON array of tasks, got {type(data).__name__}")
    tasks = [_parse_task(item) for item in data]
    # Validate unique IDs
    ids = [t.id for t in tasks]
    if len(ids) != len(set(ids)):
        duplicates = [i for i in ids if ids.count(i) > 1]
        raise ValueError(f"Duplicate task IDs: {duplicates}")
    return tasks
