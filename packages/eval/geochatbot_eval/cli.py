"""CLI entry point: `python -m geochatbot_eval`."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path


def _cmd_run(args: argparse.Namespace) -> None:
    """Run tasks against the widget and write a raw JSON run file."""
    from .runner import run_tasks_batch
    from .scorer import score_task
    from .tasks import load_tasks

    tasks = load_tasks(args.tasks)
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    api_key = args.api_key

    if not api_key:
        print("Error: --api-key is required (or set ANTHROPIC_API_KEY)", file=sys.stderr)
        sys.exit(1)

    all_records: list[dict] = []

    for model in models:
        print(f"Running {len(tasks)} tasks with model={model} ...", file=sys.stderr)
        raw_results = asyncio.run(
            run_tasks_batch(
                tasks,
                api_key=api_key,
                model=model,
                site_url=args.site,
                timeout_ms=int(args.timeout * 1000),
                headless=not args.headed,
            )
        )

        for task, run_result in zip(tasks, raw_results):
            score = score_task(
                task,
                actual_steps=run_result.plan_steps,
                result_text=run_result.result_text,
                feature_count=run_result.feature_count,
            )
            record = {
                "model": model,
                "task_id": task.id,
                "passed": score.passed,
                "plan_pass": score.plan_pass,
                "answer_pass": score.answer_pass,
                "latency_ms": run_result.latency_ms,
                "timed_out": run_result.timed_out,
                "error": run_result.fatal_error,
                "score_detail": score.detail,
                "run_result": run_result.to_dict(),
            }
            all_records.append(record)
            status = "PASS" if score.passed else "FAIL"
            print(
                f"  [{status}] {task.id} (plan={'OK' if score.plan_pass else 'FAIL'}, "
                f"answer={'OK' if score.answer_pass else 'FAIL'}, "
                f"latency={run_result.latency_ms:.0f}ms)",
                file=sys.stderr,
            )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(all_records, indent=2), encoding="utf-8")
    print(f"\nRun saved to {out_path}", file=sys.stderr)


def _cmd_leaderboard(args: argparse.Namespace) -> None:
    """Aggregate run JSON files into a Markdown leaderboard."""
    from .leaderboard import render_leaderboard

    # Support glob patterns and empty string (no runs yet)
    run_paths: list[Path] = []
    if args.runs:
        for pattern in args.runs:
            pattern = pattern.strip()
            if not pattern:
                continue
            p = Path(pattern)
            if "*" in pattern or "?" in pattern:
                import glob as _glob
                run_paths.extend(Path(x) for x in _glob.glob(pattern))
            elif p.exists():
                run_paths.append(p)

    md = render_leaderboard(run_paths)

    if args.out == "-":
        print(md)
    else:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(md, encoding="utf-8")
        print(f"Leaderboard written to {out_path}", file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m geochatbot_eval",
        description="GeoChatBot evaluation harness",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # --- run subcommand ---
    run_p = sub.add_parser("run", help="Run tasks against the widget")
    run_p.add_argument(
        "--site",
        default="http://localhost:5173/app",
        help="Widget site URL (default: %(default)s)",
    )
    run_p.add_argument(
        "--tasks",
        required=True,
        help="Path to the tasks JSON file",
    )
    run_p.add_argument(
        "--models",
        required=True,
        help="Comma-separated list of model IDs",
    )
    run_p.add_argument(
        "--api-key",
        default=None,
        help="Anthropic API key (defaults to $ANTHROPIC_API_KEY env var)",
    )
    run_p.add_argument(
        "--out",
        required=True,
        help="Output JSON file path for the run results",
    )
    run_p.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="Per-task timeout in seconds (default: %(default)s)",
    )
    run_p.add_argument(
        "--headed",
        action="store_true",
        default=False,
        help="Run browser in headed mode (default: headless)",
    )
    run_p.set_defaults(func=_cmd_run)

    # --- leaderboard subcommand ---
    lb_p = sub.add_parser("leaderboard", help="Generate Markdown leaderboard from run files")
    lb_p.add_argument(
        "--runs",
        nargs="*",
        default=[],
        help="Run JSON file paths or glob patterns",
    )
    lb_p.add_argument(
        "--out",
        default="-",
        help="Output Markdown file (default: stdout)",
    )
    lb_p.set_defaults(func=_cmd_leaderboard)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Resolve ANTHROPIC_API_KEY env var if not provided on CLI
    if hasattr(args, "api_key") and args.api_key is None:
        import os
        args.api_key = os.environ.get("ANTHROPIC_API_KEY")

    args.func(args)


if __name__ == "__main__":
    main()
