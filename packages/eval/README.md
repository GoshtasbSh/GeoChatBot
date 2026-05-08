# GeoChatBot Eval Harness

Python + Playwright evaluation harness for the GeoChatBot widget. Drives the widget headlessly, captures plan + result events, scores them against expected answers, and emits a Markdown leaderboard.

## Prerequisites

- Python 3.11+
- A running GeoChatBot app at `http://localhost:5173/app` (Phase 8 deliverable — see `packages/site/`)
- An Anthropic API key

## Install

Using `uv` (recommended for fast installs):

```bash
cd packages/eval
uv venv
source .venv/bin/activate
uv pip install -e .
```

Or plain pip:

```bash
cd packages/eval
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

Install Playwright browsers:

```bash
playwright install chromium
```

## Run evaluations

```bash
export ANTHROPIC_API_KEY=sk-ant-...

python -m geochatbot_eval run \
  --site http://localhost:5173/app \
  --tasks tasks/nyc_311_v1.json \
  --models claude-sonnet-4-6,claude-haiku-4-5-20251001 \
  --api-key $ANTHROPIC_API_KEY \
  --out runs/run-$(date +%Y%m%d-%H%M%S).json
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--site` | `http://localhost:5173/app` | Widget URL |
| `--tasks` | — | Path to task JSON (required) |
| `--models` | — | Comma-separated model IDs (required) |
| `--api-key` | `$ANTHROPIC_API_KEY` | Anthropic API key |
| `--out` | — | Output JSON path (required) |
| `--timeout` | `60` | Per-task timeout in seconds |
| `--headed` | off | Run browser in headed mode (useful for debugging) |

## Generate leaderboard

```bash
python -m geochatbot_eval leaderboard \
  --runs runs/*.json \
  --out ../../EVALS.md
```

This updates `EVALS.md` at the repo root. Pipe to stdout by omitting `--out`.

## Run tests

```bash
pytest
```

Or with coverage:

```bash
pip install pytest-cov
pytest --cov=geochatbot_eval --cov-report=term-missing
```

## How to add a new task

1. Open `tasks/nyc_311_v1.json` (or create a new version file).
2. Add an entry following the schema defined in `geochatbot_eval/tasks.py`.
3. Each task needs:
   - `id` — unique string
   - `question` — plain-English question for the widget
   - `dataset_refs` — list of dataset names (must be registered in `runner.py`)
   - `acceptable_plan_shapes` — list of ordered step-tool sequences; at least one must end in `render.*`
   - `expected` — one of `{"kind": "numeric", ...}`, `{"kind": "geometry", ...}`, or `{"kind": "text", ...}`
4. Pass the new task file via `--tasks`.

## How to swap the dataset

1. Drop new fixture files in `geochatbot_eval/fixtures/`.
2. Register them in `runner.py` in the `_DATASET_FILES` dict.
3. Create a new task file (e.g. `tasks/cedar_key_v1.json`) referencing the new dataset names in `dataset_refs`.
4. Run with `--tasks tasks/cedar_key_v1.json`.

## File structure

```
packages/eval/
├── pyproject.toml
├── README.md
├── .gitignore
├── geochatbot_eval/
│   ├── __init__.py
│   ├── tasks.py          # Task dataclass + loader
│   ├── runner.py         # Playwright-driven runner
│   ├── scorer.py         # Plan-shape + answer scoring
│   ├── leaderboard.py    # Aggregate runs → Markdown table
│   ├── cli.py            # `python -m geochatbot_eval` entry point
│   └── fixtures/
│       ├── nyc311_sample.csv       # 50-row synthesized sample
│       └── nyc_boroughs.geojson    # 5-polygon borough boundaries
├── tasks/
│   └── nyc_311_v1.json   # 8 evaluation tasks (v1)
└── tests/
    ├── test_scorer.py
    ├── test_tasks_schema.py
    └── test_leaderboard.py
```
