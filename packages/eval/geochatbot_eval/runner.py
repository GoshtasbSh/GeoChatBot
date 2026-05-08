"""Playwright-driven runner that drives the GeoChatBot widget headlessly."""

from __future__ import annotations

import asyncio
import csv
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .tasks import Task

# Path to fixture files bundled with the package
_FIXTURES_DIR = Path(__file__).parent / "fixtures"

# Dataset registry: maps a dataset_ref name to a fixture file and loader
_DATASET_FILES: dict[str, Path] = {
    "nyc311": _FIXTURES_DIR / "nyc311_sample.csv",
    "boroughs": _FIXTURES_DIR / "nyc_boroughs.geojson",
}


def _load_csv_as_records(path: Path) -> list[dict[str, Any]]:
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        return list(reader)


def _load_geojson(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class RunResult:
    """Raw captured output from one task run."""

    task_id: str
    model: str
    site_url: str
    plan_events: list[dict] = field(default_factory=list)
    progress_events: list[dict] = field(default_factory=list)
    result_events: list[dict] = field(default_factory=list)
    error_events: list[dict] = field(default_factory=list)
    critic_events: list[dict] = field(default_factory=list)
    latency_ms: float = 0.0
    timed_out: bool = False
    fatal_error: str | None = None

    # ---- convenience helpers ------------------------------------------------

    @property
    def plan_steps(self) -> list[dict]:
        """Return the step list from the first plan event, if any."""
        if not self.plan_events:
            return []
        payload = self.plan_events[0]
        # The widget emits { detail: { plan: { steps: [...] } } }
        # After JSON-serialisation through postMessage the structure may vary.
        if "detail" in payload:
            payload = payload["detail"]
        plan = payload.get("plan", payload)
        return plan.get("steps", [])

    @property
    def result_text(self) -> str:
        """Concatenate all summary text from result events."""
        parts: list[str] = []
        for ev in self.result_events:
            d = ev.get("detail", ev)
            # Try common shapes the widget uses
            for key in ("summary", "text", "value", "label"):
                val = d.get(key)
                if isinstance(val, str):
                    parts.append(val)
        return " ".join(parts)

    @property
    def feature_count(self) -> int | None:
        """Return feature count from the first 'layer' result event, if any."""
        for ev in self.result_events:
            d = ev.get("detail", ev)
            if d.get("kind") == "layer":
                fc = d.get("featureCollection") or d.get("feature_collection")
                if isinstance(fc, dict):
                    features = fc.get("features", [])
                    return len(features)
        return None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "model": self.model,
            "site_url": self.site_url,
            "plan_events": self.plan_events,
            "progress_events": self.progress_events,
            "result_events": self.result_events,
            "error_events": self.error_events,
            "critic_events": self.critic_events,
            "latency_ms": self.latency_ms,
            "timed_out": self.timed_out,
            "fatal_error": self.fatal_error,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "RunResult":
        return cls(**d)


async def run_task(
    page,  # playwright.async_api.Page
    task: Task,
    *,
    api_key: str,
    model: str,
    site_url: str = "http://localhost:5173/app",
    timeout_ms: int = 60_000,
) -> RunResult:
    """Drive the widget end-to-end and capture plan + result events.

    Steps:
      1. page.goto(site_url)
      2. Inject API key + model via window.geoChatBotElement.setProvider(...)
      3. Push fixture data via .pushData(...)
      4. Attach JS event listeners to capture plan / progress / result / error / critic
      5. Call .ask(task.question), then .approvePlan() once plan event fires
      6. Wait until __lastExecution settles or timeout fires
      7. Return RunResult
    """
    result = RunResult(task_id=task.id, model=model, site_url=site_url)

    try:
        await page.goto(site_url, timeout=timeout_ms)

        # Build dataset payloads
        dataset_payloads: dict[str, Any] = {}
        for ref in task.dataset_refs:
            fpath = _DATASET_FILES.get(ref)
            if fpath is None:
                raise FileNotFoundError(f"No fixture registered for dataset_ref={ref!r}")
            if fpath.suffix == ".csv":
                dataset_payloads[ref] = _load_csv_as_records(fpath)
            elif fpath.suffix in (".geojson", ".json"):
                dataset_payloads[ref] = _load_geojson(fpath)
            else:
                raise ValueError(f"Unsupported fixture format: {fpath.suffix}")

        # Inject provider + data + attach listeners via a single evaluate call
        events_js = await page.evaluate(
            """
            async ([apiKey, model, datasets, question]) => {
                // Helper: wait for the widget element to be ready
                function waitForElement(sel, ms = 10000) {
                    return new Promise((resolve, reject) => {
                        const el = document.querySelector(sel);
                        if (el) { resolve(el); return; }
                        const obs = new MutationObserver(() => {
                            const el = document.querySelector(sel);
                            if (el) { obs.disconnect(); resolve(el); }
                        });
                        obs.observe(document.body, { childList: true, subtree: true });
                        setTimeout(() => { obs.disconnect(); reject(new Error('widget not found: ' + sel)); }, ms);
                    });
                }

                const el = await waitForElement('geo-chat-bot');
                window.geoChatBotElement = el;

                // Wire event collectors
                const captured = {
                    plan: [], progress: [], result: [], error: [], critic: []
                };
                for (const name of ['plan', 'progress', 'result', 'error', 'critic']) {
                    el.addEventListener(name, (e) => {
                        captured[name].push(e.detail ?? {});
                    });
                    // Also listen on prefixed variants some widgets use
                    el.addEventListener('geochatbot:' + name, (e) => {
                        captured[name].push(e.detail ?? {});
                    });
                }
                window.__gcbCaptured = captured;

                // Configure provider
                el.setProvider({ provider: 'anthropic', apiKey, model });

                // Push fixture data
                for (const [name, data] of Object.entries(datasets)) {
                    el.pushData(name, data);
                }

                // Send the question
                el.ask(question);

                return 'ok';
            }
            """,
            [api_key, model, dataset_payloads, task.question],
        )

        # Poll for a plan event (up to timeout_ms/2), then approve
        poll_interval = 500
        elapsed = 0
        plan_received = False
        timeout_half = timeout_ms // 2

        start = time.monotonic()

        while elapsed < timeout_half:
            await asyncio.sleep(poll_interval / 1000)
            elapsed = int((time.monotonic() - start) * 1000)
            plan_events = await page.evaluate("window.__gcbCaptured?.plan ?? []")
            if plan_events:
                plan_received = True
                result.plan_events = plan_events
                break

        if plan_received:
            await page.evaluate("window.geoChatBotElement.approvePlan()")

        # Wait for result or error event (remaining budget)
        remaining_ms = timeout_ms - int((time.monotonic() - start) * 1000)
        elapsed2 = 0
        poll_interval2 = 750
        while elapsed2 < remaining_ms:
            await asyncio.sleep(poll_interval2 / 1000)
            elapsed2 = int((time.monotonic() - start) * 1000) - int((time.monotonic() - start) * 1000 - elapsed2)
            captured = await page.evaluate("window.__gcbCaptured ?? {}")
            if captured.get("result") or captured.get("error"):
                break

        # Final capture
        captured = await page.evaluate("window.__gcbCaptured ?? {}")
        result.plan_events = captured.get("plan", [])
        result.progress_events = captured.get("progress", [])
        result.result_events = captured.get("result", [])
        result.error_events = captured.get("error", [])
        result.critic_events = captured.get("critic", [])
        result.latency_ms = (time.monotonic() - start) * 1000

        if not result.result_events and not result.error_events:
            result.timed_out = True

    except Exception as exc:  # noqa: BLE001
        result.fatal_error = str(exc)

    return result


async def run_tasks_batch(
    tasks: list[Task],
    *,
    api_key: str,
    model: str,
    site_url: str = "http://localhost:5173/app",
    timeout_ms: int = 60_000,
    headless: bool = True,
) -> list[RunResult]:
    """Run a list of tasks sequentially under a single Playwright browser context."""
    from playwright.async_api import async_playwright

    results: list[RunResult] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        context = await browser.new_context()
        try:
            for task in tasks:
                page = await context.new_page()
                try:
                    res = await run_task(
                        page,
                        task,
                        api_key=api_key,
                        model=model,
                        site_url=site_url,
                        timeout_ms=timeout_ms,
                    )
                    results.append(res)
                finally:
                    await page.close()
        finally:
            await context.close()
            await browser.close()
    return results
