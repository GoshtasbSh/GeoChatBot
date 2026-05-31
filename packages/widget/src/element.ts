import { tableFromJSON } from "apache-arrow";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { makeAnthropicLoopCall } from "./agent/agentic/loop-anthropic.js";
import type {
	CriticDecision,
	StepErrorContext,
} from "./agent/executor/index.js";
import {
	type DatasetEntry as ExecDatasetEntry,
	type ProgressEvent as ExecProgressEvent,
	type ResultEvent as ExecResultEvent,
	Executor,
	type ExecutorEngine,
	type ResultPayload,
} from "./agent/executor/index.js";
import { callForcedTool } from "./agent/forced-tool/index.js";
import {
	Critic,
	DEFAULT_PROVIDER_ID,
	Planner,
	clearUserMemory,
	defaultModelFor,
} from "./agent/index.js";
import type {
	Plan,
	DatasetProfile as PlannerDatasetProfile,
	ProviderId,
} from "./agent/index.js";
import type { PlannerLLMInput } from "./agent/llm.js";
import { augmentProfile } from "./agent/profile/augment.js";
import { PlanValidationError, validatePlan } from "./agent/validate-plan.js";
import { validateSql } from "./agent/validate-sql.js";
import { checkClaimGrounding } from "./agent/verify/claim-grounding.js";
import { friendlyExecError } from "./agent/verify/error-message.js";
import {
	type GuardResult,
	guardColorBy,
	guardLayerNonEmpty,
} from "./agent/verify/outcome-guards.js";
import { correctSummary } from "./agent/verify/summary-corrector.js";
import type {
	BinaryInput,
	DatasetProfile,
	GeometryEncoding,
	LoadResult,
	SourceFormat,
} from "./data/contracts";
import { getEngine } from "./data/engine";
import type { DuckDBEngine } from "./data/engine/DuckDBEngine.js";
import { loadFile } from "./data/loaders";
import { profileDataset } from "./data/profile";
import {
	type ChatProvider,
	setProvider as setActiveProvider,
} from "./providers/index";
import { type ThemeMode, applyTheme, subscribeOSTheme } from "./state/theme.js";
import { tokensCSS } from "./ui/tokens.js";
import "./ui/plan-review.js";
import type { PlanReview } from "./ui/plan-review.js";
import "./ui/modal.js";
import "./ui/upload-popover.js";
import "./ui/shell.js";
import type { ShellTab } from "./ui/shell.js";
import "./ui/rail.js";
import { type SavedResultV1, SavesStore } from "./state/saves-store.js";
import "./ui/result-canvas.js";
import "./ui/settings-drawer.js";
import type { SettingsValue } from "./ui/settings-drawer.js";
import "./ui/ask-input.js";
import type { AskInputDisabledReason } from "./ui/ask-input.js";
// MapView (MapLibre GL + deck.gl) is lazy-loaded on first geometry ingest
// so the initial bundle stays lean (PLAN §3 hard rule: ≤ 100 KB gzipped).

/**
 * Pick up to 3 representative example values per column from the
 * already-computed profile. We never go back to the raw rows — only
 * profile-derived summaries are exposed:
 *   - string columns: the 3 most-frequent distinct values
 *   - numeric/date columns: the min and max bounds
 *   - others: nothing (would expose opaque binary / other types)
 */
function deriveColumnSamples(
	c: import("./data/contracts.js").ColumnProfile,
): unknown[] {
	if (c.kind === "string" && c.categorical?.top?.length) {
		// For a low-cardinality column, surface the COMPLETE distinct value set
		// (up to 12) so the planner can filter with exact `=` and copy the real
		// literal/casing — NL2SQL's biggest accuracy-per-line win. Otherwise
		// 3 representative examples are enough to convey semantics.
		const distinct = c.categorical.distinct;
		const cap = distinct <= 12 ? 12 : 3;
		return c.categorical.top.slice(0, cap).map((t) => t.value);
	}
	if ((c.kind === "integer" || c.kind === "float") && c.numeric) {
		return [c.numeric.min, c.numeric.max];
	}
	if ((c.kind === "date" || c.kind === "timestamp") && c.range) {
		return [c.range.min, c.range.max];
	}
	return [];
}

/**
 * Map an ingest-side {@link DatasetProfile} (from data/contracts) into the
 * Planner-side profile shape.
 *
 * Per-column representative samples ARE included — but only ones already
 * synthesized by the profiler (top-frequency string values, numeric/date
 * range bounds), never arbitrary row content. The samples are rendered
 * inside the UNTRUSTED_DATASET_PROFILE fence in `planner.ts`, so the
 * planner treats every byte as opaque data. They exist because the
 * planner system prompt instructs the LLM to inspect sample values to
 * identify columns (e.g., distinguishing an "Address" column from a
 * generic "Notes" column when both are typed as Utf8) — without samples
 * the planner had to guess from column names alone, which is fragile.
 */
function toPlannerDatasetProfile(
	name: string,
	profile: DatasetProfile,
): PlannerDatasetProfile {
	const kind: "table" | "layer" = profile.geometry ? "layer" : "table";
	const columns = profile.columns.map((c) => {
		const out: PlannerDatasetProfile["columns"][number] = {
			name: c.name,
			type: c.arrowType,
			nulls: c.nullCount,
		};
		// 2026-05-21: forward distinct count for categorical columns so
		// the planner-side colorBy ranker (builders.ts:scoreColorByCandidate)
		// can score this column instead of falling back to the "unknown
		// cardinality" branch. Previously this was silently dropped.
		if (c.categorical?.distinct !== undefined) {
			out.cardinality = c.categorical.distinct;
		}
		const samples = deriveColumnSamples(c);
		if (samples.length > 0) out.samples = samples;
		return out;
	});
	const planner: PlannerDatasetProfile = {
		name,
		kind,
		rows: profile.rowCount,
		columns,
		sample: [],
	};
	if (profile.geometry) {
		// The ingest profile carries an `encoding` discriminator
		// (`lonlat` | `geojson-string` | `wkb`), not the planner's `kind`
		// (point/line/polygon/multi). We can't reliably infer feature
		// dimensionality from encoding alone, so default to `point` for
		// lonlat (which always represents points) and `multi` otherwise.
		const geomKind: "point" | "line" | "polygon" | "multi" =
			profile.geometry.encoding === "lonlat" ? "point" : "multi";
		planner.geometry = {
			kind: geomKind,
			column: profile.geometry.column,
			...(profile.geometry.crsGuess ? { crs: profile.geometry.crsGuess } : {}),
			...(profile.geometry.bbox ? { bbox: profile.geometry.bbox } : {}),
		};
	}
	return augmentProfile(planner);
}

/**
 * Adapter: produce an {@link ExecutorEngine} view over a {@link DuckDBEngine}.
 *
 * `hasSpatial` is exposed as a getter so the executor sees the up-to-date
 * value at call time (the engine flips this from `false` to `true` after
 * `LOAD spatial` succeeds during init). A flat property snapshot taken at
 * adapter construction would freeze the value pre-init.
 */
function toExecutorEngine(eng: DuckDBEngine): ExecutorEngine {
	return {
		query: (sql) => eng.query(sql),
		get hasSpatial() {
			return eng.hasSpatial;
		},
	};
}

/** Stable error code for an arbitrary thrown value, never the raw object. */
function errCode(err: unknown): string {
	// Prefer an explicit `code` property when present (set by provider
	// adapters and the agentic loop for typed cases like RATE_LIMIT,
	// AUTH, NETWORK). These codes are what surfaces to the host's UI
	// and the demo log, so a user hitting Groq's 12k TPM ceiling sees
	// "RATE_LIMIT" rather than the generic "Error".
	if (err && typeof err === "object" && "code" in err) {
		const c = (err as { code?: unknown }).code;
		if (typeof c === "string" && c) return c;
	}
	if (
		err &&
		typeof err === "object" &&
		"name" in err &&
		typeof err.name === "string"
	) {
		return err.name;
	}
	return "UNKNOWN";
}

/** Best-effort message extraction; never throws, never leaks Error.cause. */
function errMessage(err: unknown, fallback = "unknown error"): string {
	if (err instanceof Error && err.message) return err.message;
	if (typeof err === "string" && err) return err;
	return fallback;
}

/** Operating modes — see {@link GeoChatBotElement.setMode}. */
export type GeoChatBotMode = "full" | "headless";

/**
 * Typed event map dispatched by {@link GeoChatBotElement}.
 *
 * Every event is dispatched twice on the host: once with the unprefixed
 * key (e.g. `plan`) and once with the namespaced form
 * `geochatbot:<key>`. Hosts may listen on either; the typed `on()` helper
 * uses the namespaced form.
 *
 * - `dataset-loaded` — fires when ingest completes for a file/blob.
 * - `plan`           — Planner produced a Plan; awaiting approve/reject.
 * - `progress`       — per-step status during plan execution. Plan-level
 *                      beats: `'rejected'` (user clicked Reject / replan path),
 *                      `'cancelled'` (modal dismissed without replanning).
 * - `result`         — render.* step produced a payload (one per render step).
 * - `error`          — any ingest, planner, validator, or executor failure.
 *                      We never include raw Error objects; only `message`
 *                      and `code` strings (prevents leaking request URLs /
 *                      Authorization headers via Error.cause).
 */
export type GeoChatBotEvents = {
	"dataset-loaded": {
		name: string;
		source: SourceFormat;
		profile: DatasetProfile;
		engineRegistered: boolean;
	};
	plan: {
		planId: string;
		plan: Plan;
		datasets: ReadonlyArray<PlannerDatasetProfile>;
	};
	progress: {
		planId: string;
		/** Step id from the plan, or undefined for plan-level beats (e.g. `'rejected'`, `'cancelled'`). */
		stepId?: string;
		status: "running" | "success" | "fail" | "rejected" | "cancelled";
		durationMs?: number;
		error?: string;
	};
	result: ExecResultEvent;
	error: {
		message: string;
		code?: string;
		planId?: string;
		stepId?: string;
	};
	critic: {
		planId: string;
		stepId: string;
		/** 1-based attempt number (1 = first try; 2 = first retry; …). */
		attempt: number;
		/** Total budget = maxRetries + 1. */
		maxAttempts: number;
		/** What the critic decided. */
		decision: "patch" | "retry" | "abort";
		/** The original error message (already truncated for the prompt). */
		errorMessage: string;
		/** Args before substitution — what the runner actually saw. */
		beforeArgs: Record<string, unknown>;
		/** Patched args, only when decision==='patch'. */
		afterArgs?: Record<string, unknown>;
	};
	/**
	 * Agentic-loop reasoning event. Fires once per iteration in agentic
	 * mode. Hosts can subscribe to surface live "thinking" in their own
	 * UI (the built-in result-canvas already does this via the
	 * `<gcb-thinking>` panel).
	 */
	"agentic-step":
		| { kind: "reason"; iteration: number; text: string | null }
		| {
				kind: "tool";
				iteration: number;
				toolId: string;
				args: Record<string, unknown>;
				observation: string;
		  }
		| { kind: "finalize"; iteration: number; plan: Plan }
		| { kind: "budget-exhausted"; iteration: number }
		| { kind: "unknown-tool"; iteration: number; toolId: string }
		// AUDIT-K4 (2026-05-11): forwarded from the agentic loop while it
		// waits on a 429 backoff. Hosts wire this to a countdown card.
		| {
				kind: "rate-limit-wait";
				iteration: number;
				attempt: number;
				waitMs: number;
		  }
		// Fired when the model calls ask_user — the loop is paused.
		| { kind: "clarify-needed"; iteration: number; question: string };
};

/**
 * Reliable loop: total plan→execute→verify attempts per question (1 initial
 * + up to 1 strategy-level recovery re-plan). Bounded to keep cost/latency
 * predictable on the UF Navigator provider.
 */
const RELIABLE_MAX_ATTEMPTS = 2;

/**
 * Execution errors that a DIFFERENT plan can fix (the plan referenced a tool,
 * dataset, or runner that doesn't exist / isn't implemented). These trigger a
 * strategy re-plan. Generic runtime failures (SQL errors, engine offline, CRS
 * issues) are deliberately excluded — those are the step-critic's job, and
 * re-planning the same approach won't help.
 */
const REPLANNABLE_ERROR =
	/unknown dataset|not implemented|no runner registered|not in the available tool|missing_runner|unknown tool|\$\{|output_var.*collides|collides with loaded dataset/i;
// A literal `${` reaching SQL means an unsubstituted step-output variable — a
// recurring LLM mistake (writing `FROM ${x}` instead of `FROM x`). Matched
// above so it re-plans; the `\$\{` token is specific enough not to collide
// with the step-critic's ordinary SQL/runtime errors.
const UNSUBSTITUTED_VAR = /\$\{/;

const EVENT_NAME: Record<keyof GeoChatBotEvents, string> = {
	"dataset-loaded": "geochatbot:dataset-loaded",
	result: "geochatbot:result",
	plan: "geochatbot:plan",
	progress: "geochatbot:progress",
	error: "geochatbot:error",
	critic: "geochatbot:critic",
	"agentic-step": "geochatbot:agentic-step",
};

/**
 * <geo-chatbot> — top-level Web Component.
 *
 * Phase 2 surface:
 *   - file drop / picker / programmatic {@link pushData} all funnel through
 *     a single ingest path
 *   - typed `result` / `error` / `plan` events via {@link on}
 *   - {@link setProvider} stores the active LLM provider for the agent loop
 *   - {@link clear} resets all loaded state (provider survives)
 *   - full CSS-variable theming with a built-in `theme="dark"` mode
 *
 * Style isolation comes from Shadow DOM.
 */
@customElement("geo-chatbot")
export class GeoChatBotElement extends LitElement {
	static styles = [
		tokensCSS,
		css`
      /* The legacy color tokens map onto the new ones so any host page
         that already overrides --gcb-bg / --gcb-fg / etc. still works. */
      :host {
        --gcb-fg: var(--gcb-ink);
        --gcb-muted-fg: var(--gcb-ink-muted);
        --gcb-border: var(--gcb-line);
        --gcb-table-bg: var(--gcb-bg-3);
        --gcb-error-bg: color-mix(in srgb, #ef4444 14%, transparent);
        --gcb-error-fg: #b91c1c;
        --gcb-accent-soft-bg: var(--gcb-accent-soft);
        --gcb-accent-badge-bg: var(--gcb-accent-soft);
        --gcb-drop-border: var(--gcb-line);
        --gcb-geom-fg: var(--gcb-accent);
        --gcb-radius: var(--gcb-radius-lg);
        --gcb-shadow: var(--gcb-shadow-1);
        --gcb-font: var(--gcb-font-sans);
        --gcb-map-height: 360px;

        display: block;
        /* Sensible default size when the host doesn't constrain us. Hosts
         * that explicitly set 'height' (e.g. fullscreen demo with
         * height: 100vh) override this. */
        min-height: 640px;
        height: 100%;
        box-sizing: border-box;
        font-family: var(--gcb-font);
        color: var(--gcb-ink);
        background: var(--gcb-bg);
        border: 1px solid var(--gcb-line);
        border-radius: var(--gcb-radius);
        box-shadow: var(--gcb-shadow);
        padding: 0;
      }
      header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      header h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; }
      .status-chip {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; padding: 3px 8px 3px 6px; border-radius: 999px;
        background: var(--gcb-accent-soft); color: var(--gcb-accent);
        border: 1px solid var(--gcb-line);
      }
      .status-chip.muted { background: transparent; color: var(--gcb-ink-muted); border-color: var(--gcb-line); }
      .status-chip .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--gcb-accent); }
      .status-chip .dot-muted { background: var(--gcb-ink-muted); box-shadow: none; }
      .icon-btn {
        font: inherit; font-size: 16px; line-height: 1;
        padding: 4px 8px; border-radius: var(--gcb-radius-sm);
        border: 1px solid var(--gcb-line);
        background: var(--gcb-bg-2); color: var(--gcb-ink-muted);
        cursor: pointer; transition: background 120ms ease;
      }
      .icon-btn:hover { background: var(--gcb-accent-soft); color: var(--gcb-accent); }
      .drop {
        border: 2px dashed var(--gcb-line); border-radius: var(--gcb-radius);
        padding: 28px; text-align: center; cursor: pointer;
        transition: border-color .15s, background .15s;
      }
      .drop.over { border-color: var(--gcb-accent); background: var(--gcb-accent-soft); }
      .drop p { margin: 0; color: var(--gcb-ink-muted); font-size: 14px; }
      .hint { font-size: 12px; color: var(--gcb-ink-muted); margin-top: 4px; opacity: 0.8; }
      .tables { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
      .table-card {
        border: 1px solid var(--gcb-line); border-radius: var(--gcb-radius-sm);
        padding: 12px; background: var(--gcb-bg-3);
      }
      .table-card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
      .table-card .summary { font-size: 12px; color: var(--gcb-ink-muted); margin-bottom: 8px; }
      table { border-collapse: collapse; font-size: 12px; width: 100%; }
      th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--gcb-line); }
      th { color: var(--gcb-ink-muted); font-weight: 500; }
      .err {
        margin-top: 12px; padding: 10px; border-radius: var(--gcb-radius-sm);
        background: var(--gcb-error-bg);
        color: var(--gcb-error-fg); font-size: 13px;
      }
      .geom { color: var(--gcb-accent); font-weight: 500; }
      gcb-map { margin-top: 12px; }

      /* ─── Topbar (combined design) ────────────────────────────── */
      .tb-row {
        display: flex; align-items: center; gap: 10px;
        height: 100%; padding: 0 14px 0 10px;
      }
      .tb-rail-spacer { width: 38px; flex-shrink: 0; }
      .logo-mark {
        width: 22px; height: 22px; border-radius: 6px;
        background: var(--gcb-accent);
        display: grid; place-items: center; flex-shrink: 0;
      }
      .logo-mark svg { color: var(--gcb-accent-fg); }
      .logo-text {
        font-size: 15px; font-weight: 700;
        letter-spacing: -.02em; color: var(--gcb-ink);
      }
      .tb-gap { flex: 1; }

      .tb-icon-btn {
        width: 32px; height: 32px; border-radius: var(--gcb-radius-sm);
        border: 1px solid var(--gcb-line); background: transparent;
        color: var(--gcb-ink-muted);
        display: grid; place-items: center; cursor: pointer;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
        flex-shrink: 0;
      }
      .tb-icon-btn:hover {
        background: var(--gcb-bg-3); color: var(--gcb-ink);
        border-color: var(--gcb-line-strong);
      }
      .tb-icon-btn:focus-visible {
        outline: 2px solid var(--gcb-accent); outline-offset: 2px;
      }

      .upload-wrap { position: relative; }

      /* ─── Icon rail ───────────────────────────────────────────── */
      .ir {
        display: flex; flex-direction: column; align-items: center;
        padding: 8px 0; gap: 2px; height: 100%;
      }
      .ir-btn {
        width: 36px; height: 36px; border-radius: var(--gcb-radius-sm);
        border: 0; background: transparent; color: var(--gcb-ink-muted);
        display: grid; place-items: center; cursor: pointer;
        position: relative; flex-shrink: 0;
        transition: background 120ms ease, color 120ms ease;
      }
      .ir-btn:hover { background: var(--gcb-accent-soft); color: var(--gcb-ink); }
      .ir-btn.active { color: var(--gcb-accent); }
      .ir-btn.active::before {
        content: ''; position: absolute;
        left: -7px; top: 7px; bottom: 7px; width: 3px;
        background: var(--gcb-accent); border-radius: 0 2px 2px 0;
      }
      .ir-btn:focus-visible {
        outline: 2px solid var(--gcb-accent); outline-offset: 2px;
      }
      .ir-gap { flex: 1; }

      /* ─── Status chip refinements ─────────────────────────────── */
      .status-chip {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 10px; border-radius: 999px;
        background: var(--gcb-accent-soft);
        border: 1px solid var(--gcb-accent-ring);
        color: var(--gcb-accent-ink);
        font-size: 11px; font-weight: 500;
      }
      .status-chip .dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--gcb-accent);
        animation: gcb-pulse 2s ease-in-out infinite;
      }
      @keyframes gcb-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.45; transform: scale(0.85); }
      }
      @keyframes gcb-spin {
        to { transform: rotate(360deg); }
      }

      .err {
        margin: 12px 20px; padding: 10px 12px; border-radius: var(--gcb-radius-sm);
        background: var(--gcb-error-bg);
        color: var(--gcb-error-fg); font-size: 13px;
      }
    `,
	];

	@state() private loaded: LoadResult[] = [];
	@state() private profiles: Record<string, DatasetProfile> = {};
	@state() private error: string | null = null;
	@state() private busy = false;
	/** Becomes true once the MapView module has been dynamically imported. */
	@state() private _mapModuleLoaded = false;

	/**
	 * Operating mode. In `'headless'`, the widget does NOT render the map /
	 * tables / drop zone — it only emits typed CustomEvents so a host page
	 * can wire the agent's output into its own UI. Reflects to the `mode`
	 * attribute so it is settable from HTML markup.
	 */
	@property({ reflect: true })
	mode: GeoChatBotMode = "full";

	/** Theme mode. `auto` follows OS, otherwise the explicit setting wins.
	 *  Reflects to the `theme` attribute so the token sheet's
	 *  `:host([theme="dark"])` selector can react. */
	@property({ reflect: true })
	theme: ThemeMode = "auto";

	/**
	 * Explicit acknowledgement that the host accepts the API-key exposure
	 * inherent in calling Anthropic directly from the browser. Defaults to
	 * `false`, in which case `ask()` emits an `error` event instead of
	 * issuing the LLM call. Production deployments should keep this `false`
	 * and proxy through a server-side endpoint that injects the key.
	 *
	 * Settable from HTML as `<geo-chatbot dangerously-allow-browser>`.
	 */
	@property({
		type: Boolean,
		attribute: "dangerously-allow-browser",
		reflect: true,
	})
	dangerouslyAllowBrowser = false;

	/**
	 * When false, API keys are never persisted to `localStorage` and are not
	 * reloaded on page refresh — only held in memory after Save or
	 * {@link setProvider}. Recommended for embedded dashboards on shared
	 * origins; inject keys per session from the host instead.
	 *
	 * Set with `<geo-chatbot persist-api-key="false">`.
	 */
	@property({ type: Boolean, attribute: "persist-api-key", reflect: true })
	persistApiKey = true;

	/**
	 * Plan generation mode:
	 *   - `'single-shot'` (default): one forced-tool LLM call → Plan. Cheapest,
	 *     works on every provider (Anthropic/Gemini/Groq/OpenAI).
	 *   - `'agentic'`: multi-turn ReAct loop. The LLM probes the loaded data
	 *     with inspection tools (sample_rows, distinct_values, column_pattern,
	 *     probe_sql) BEFORE committing to a Plan, so it can reason about which
	 *     columns are spatial / address-like / etc. This is the value-prop
	 *     over a generic chatbot — without it, unfamiliar datasets produce
	 *     blind plans. Recommended for any non-trivial dataset.
	 *
	 * The agentic loop only supports OpenAI-compatible providers (Groq +
	 * OpenAI + OpenRouter + Together). On Anthropic/Gemini the planner
	 * automatically falls back to single-shot and dispatches an
	 * `AGENTIC_FALLBACK` warning event.
	 *
	 * Set via the `agentic-mode` attribute. The fullscreen demo
	 * (packages/demo/index.html) and the embedded /app standalone both
	 * default to "agentic" because they target the reasoning use-case.
	 */
	@property({ reflect: true, attribute: "agentic-mode" })
	agenticMode: "single-shot" | "agentic" = "single-shot";

	/**
	 * RAG retrieval mode:
	 *   - `'auto'` (default): on in browser, off in Node tests.
	 *   - `'on'` / `'off'`: explicit override.
	 *
	 * When on, the planner retrieves top-K most-relevant docs + similar past
	 * accepted plans for each question, replacing the static few-shot block
	 * with a dynamically-tailored one.
	 */
	@property({ reflect: true, attribute: "retrieval" })
	retrievalMode: "auto" | "on" | "off" = "auto";

	/**
	 * Persist approved (question, plan) pairs into IndexedDB so the next
	 * session retrieves them as few-shots. **Default: false (opt-in).**
	 *
	 * The user's question text — which can include PII like addresses or
	 * names typed inline — is stored verbatim. This contradicts the
	 * "browser-only, no data leaves your device" framing if it persists
	 * silently, so the toggle defaults off. When true, hosts SHOULD
	 * surface a settings UI affordance to wipe history; this widget's
	 * built-in settings drawer renders one.
	 *
	 * Use {@link clearMemory} to wipe at any time.
	 */
	@property({ type: Boolean, attribute: "memory-enabled", reflect: true })
	memoryEnabled = false;

	/** Active LLM provider, set via {@link setProvider}. Survives {@link clear}. */
	private provider: ChatProvider | undefined = undefined;

	/**
	 * Monotonic ingest generation. Bumped by {@link clear}; an in-flight
	 * ingest checks this before publishing results so a clear() mid-load
	 * does not produce a ghost result after the reset.
	 */
	private generation = 0;

	/** Counter for stub plan ids; reset by {@link clear}. */
	private planCounter = 0;

	/* -------------------------------------------------------------------- */
	/* Phase 4 planner state                                                */
	/* -------------------------------------------------------------------- */
	private _planner: Planner | undefined;
	private _llmCall:
		| ((input: PlannerLLMInput) => Promise<Record<string, unknown>>)
		| undefined;
	private _pendingPlan: { id: string; plan: Plan } | undefined;
	private _datasets: PlannerDatasetProfile[] = [];
	private _apiKey: string | undefined;
	/**
	 * Active LLM provider id. Defaults to Groq (free tier). Restored from
	 * localStorage on connect; updated by the settings drawer on Save.
	 */
	private _llmProvider: ProviderId = DEFAULT_PROVIDER_ID;
	private _model = defaultModelFor(DEFAULT_PROVIDER_ID);

	/* -------------------------------------------------------------------- */
	/* Phase 5 executor state                                               */
	/* -------------------------------------------------------------------- */
	/** DuckDB view names registered per logical dataset name. */
	private _execDatasets: ExecDatasetEntry[] = [];
	/** Test-only override; otherwise the executor uses the main-thread DuckDB singleton. */
	private _executorEngine: ExecutorEngine | undefined;

	/* -------------------------------------------------------------------- */
	/* Phase 6 critic state                                                 */
	/* -------------------------------------------------------------------- */
	private _criticOverride:
		| {
				diagnose: (
					ctx: StepErrorContext,
					signal?: AbortSignal,
				) => Promise<CriticDecision>;
		  }
		| undefined;
	/**
	 * Per-execution AbortController. Signal is passed to every Critic LLM
	 * call so {@link clear} can cancel in-flight Anthropic round-trips
	 * instead of leaving them dangling (and burning tokens) when the user
	 * walks away or starts a new ask().
	 */
	private _execAbort: AbortController | undefined;

	/**
	 * Per-plan AbortController. Signal is passed to the planner LLM call so
	 * {@link clear}, {@link disconnectedCallback}, and a settings-save
	 * during planning can cancel the in-flight LLM round-trip instead of
	 * just suppressing the response (which still burns the user's tokens
	 * and keeps the API key in flight).
	 */
	private _planAbort: AbortController | undefined;

	/** Test-only: substitute the critic for deterministic tests. */
	__setCritic(c: {
		diagnose: (
			ctx: StepErrorContext,
			signal?: AbortSignal,
		) => Promise<CriticDecision>;
	}): void {
		this._criticOverride = c;
	}

	/* -------------------------------------------------------------------- */
	/* Settings + chat UI state                                             */
	/* -------------------------------------------------------------------- */
	/** Active dashboard tab. Slice 1 = chrome only; non-Map tabs render
	 *  a "coming in next slice" hint until Slice 2 lands. */
	@state() private _activeTab: ShellTab = "map";
	/** Whether the settings drawer is open. */
	@state() private _settingsOpen = false;
	/** Whether the upload popover is open. */
	@state() private _uploadOpen = false;
	/** True while a plan is being produced or executed; disables the Ask button. */
	@state() private _agentBusy = false;
	/** Short status message shown in the floating progress bar while _agentBusy. */
	@state() private _statusLine = "";
	/**
	 * Set when the agentic loop calls `ask_user` — holds the question text
	 * the model is asking AND the resolve function that feeds the answer
	 * back into the loop. Cleared when the user answers or the loop aborts.
	 */
	@state() private _pendingClarification:
		| { question: string; resolve: (answer: string) => void }
		| undefined = undefined;
	/** Mirrors the persisted key for the masked header chip; never the raw bytes. */
	@state() private _maskedKey: string | null = null;

	/* -------------------------------------------------------------------- */
	/* Phase 7 saves state                                                  */
	/* -------------------------------------------------------------------- */
	/** localStorage-backed saves for this widget instance. */
	saves = new SavesStore();
	/** Most recent question asked; embedded in save origins so saved results are labelled. */
	private _lastQuestion = "";
	/**
	 * Layers derived from agent execution (e.g. render.map results). Shown in
	 * the Contents panel's "Layers" section with a NEW badge until a new
	 * execution lands.
	 */
	@state() private _derivedLayers: ReadonlyArray<{
		id: string;
		name: string;
		features: number;
		visible: boolean;
		isNew: boolean;
	}> = [];

	@state() private _savesList: ReadonlyArray<SavedResultV1> = [];

	/** Currently-selected save (drives Detail tab in Slice 2). */
	@state() private _activeSaveId: string | null = null;

	private _savesChange: (() => void) | undefined;

	/* -------------------------------------------------------------------- */
	/* Persistence                                                          */
	/* -------------------------------------------------------------------- */
	/**
	 * localStorage key namespace. Values stored:
	 *   geochatbot:provider                — provider id ('groq' | 'gemini' | 'anthropic' | 'openai')
	 *   geochatbot:apiKey                  — raw API key for the active provider
	 *   geochatbot:model                   — selected model id (provider-specific)
	 *   geochatbot:dangerouslyAllowBrowser — '1' or '0' opt-in flag
	 *
	 * Stored only if the user hits Save in the drawer. Never written from
	 * setProvider() so programmatic callers don't accidentally persist a
	 * key. Reads silently no-op if localStorage is unavailable (private
	 * browsing, hardened CSP) — the widget falls back to in-memory only.
	 */
	private static readonly _STORAGE_KEYS = {
		provider: "geochatbot:provider",
		apiKey: "geochatbot:apiKey",
		model: "geochatbot:model",
		dangerouslyAllowBrowser: "geochatbot:dangerouslyAllowBrowser",
		agenticMode: "geochatbot:agenticMode",
		retrievalMode: "geochatbot:retrievalMode",
		memoryEnabled: "geochatbot:memoryEnabled",
		// AUDIT-K2 (2026-05-11): theme persistence so a dark-mode reload
		// stays dark. Cycles auto → light → dark → auto.
		theme: "geochatbot:theme",
	} as const;

	/** Provider ids the persistence layer knows about. Anything else is ignored. */
	private static readonly _KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set([
		"anthropic",
		"groq",
		"openai",
		"gemini",
		"uf-navigator",
	]);

	/**
	 * Invalidate cached planner state on attribute changes that affect
	 * planner construction. The planner caches things like the static
	 * cached-prefix and the agentic endpoint at construction time, so a
	 * runtime swap of `agentic-mode` or `retrieval` would otherwise be
	 * silently ignored until the next `clear()`. Lit calls willUpdate
	 * before render whenever a reactive property changes.
	 */
	protected override willUpdate(changed: Map<string, unknown>): void {
		// Skip the FIRST render — Lit passes every reactive property's
		// initial-undefined → default-value transition through `changed`,
		// which would otherwise wipe the just-built _planner immediately
		// after ask() created it. We only want to invalidate when a
		// human-driven config change happens (settings drawer save, host
		// setAttribute), all of which happen post-first-render.
		if (!this.hasUpdated) return;
		if (
			changed.has("agenticMode") ||
			changed.has("retrievalMode") ||
			changed.has("memoryEnabled") ||
			changed.has("dangerouslyAllowBrowser")
		) {
			this._planner = undefined;
		}
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this._restoreSettings();
		applyTheme(this, this.theme);
		// Only auto-mode visually depends on the OS preference; in light/dark
		// the rendered tokens are fully determined and a re-render is wasted.
		this._unsubscribeTheme = subscribeOSTheme(() => {
			if (this.theme === "auto") this.requestUpdate();
		});
		this._savesList = this.saves.list();
		this._savesChange = () => {
			this._savesList = this.saves.list();
		};
		this.saves.addEventListener("change", this._savesChange);
	}

	/** Read persisted settings on connect; silently no-op if storage is unavailable. */
	private _restoreSettings(): void {
		try {
			const k = GeoChatBotElement._STORAGE_KEYS;
			const persistedProvider = localStorage.getItem(k.provider);
			if (
				persistedProvider &&
				GeoChatBotElement._KNOWN_PROVIDERS.has(persistedProvider as ProviderId)
			) {
				this._llmProvider = persistedProvider as ProviderId;
			}
			const apiKey = this.persistApiKey ? localStorage.getItem(k.apiKey) : null;
			const model = localStorage.getItem(k.model);
			const dangerous = localStorage.getItem(k.dangerouslyAllowBrowser) === "1";
			if (apiKey) {
				this._apiKey = apiKey;
				this._maskedKey = this._maskKey(apiKey);
			}
			if (model) this._model = model;
			if (dangerous) this.dangerouslyAllowBrowser = true;
			const persistedAgentic = localStorage.getItem(k.agenticMode);
			if (
				persistedAgentic === "agentic" ||
				persistedAgentic === "single-shot"
			) {
				this.agenticMode = persistedAgentic;
			}
			const persistedRetrieval = localStorage.getItem(k.retrievalMode);
			if (
				persistedRetrieval === "auto" ||
				persistedRetrieval === "on" ||
				persistedRetrieval === "off"
			) {
				this.retrievalMode = persistedRetrieval;
			}
			const persistedMemory = localStorage.getItem(k.memoryEnabled);
			if (persistedMemory === "1" || persistedMemory === "0") {
				this.memoryEnabled = persistedMemory === "1";
			}
			// AUDIT-K2 (2026-05-11): restore theme. Reflected to attribute via
			// @property({reflect: true}) so the :host[theme="dark"] +
			// :host-context([theme="dark"]) rules in tokensCSS pick it up.
			const persistedTheme = localStorage.getItem(k.theme);
			if (
				persistedTheme === "light" ||
				persistedTheme === "dark" ||
				persistedTheme === "auto"
			) {
				this.theme = persistedTheme;
			}
		} catch {
			// localStorage unavailable — remain in-memory only.
		}
	}

	/** Compact masked form of a key for the header chip. Never reveals the middle. */
	private _maskKey(key: string): string {
		if (!key) return "";
		if (key.length <= 8) return "•".repeat(key.length);
		return `${key.slice(0, 4)}…${key.slice(-4)}`;
	}

	/** Short, header-friendly label for the active provider. */
	private _providerLabel(): string {
		switch (this._llmProvider) {
			case "anthropic":
				return "Anthropic";
			case "openai":
				return "OpenAI";
			case "groq":
				return "Groq";
			case "gemini":
				return "Gemini";
			case "uf-navigator":
				return "UF Navigator";
		}
	}

	private _onSaveSettings = (e: Event) => {
		const detail = (e as CustomEvent<SettingsValue>).detail;
		this._llmProvider = detail.provider;
		this._apiKey = detail.apiKey;
		this._model = detail.model;
		this.dangerouslyAllowBrowser = detail.dangerouslyAllowBrowser;
		if (detail.agenticMode) this.agenticMode = detail.agenticMode;
		if (detail.retrievalMode) this.retrievalMode = detail.retrievalMode;
		if (typeof detail.memoryEnabled === "boolean")
			this.memoryEnabled = detail.memoryEnabled;
		this._maskedKey = this._maskKey(detail.apiKey);
		// Force planner rebuild so the next ask() picks up the new tuple.
		// (willUpdate also drops _planner when agenticMode/retrievalMode
		// change, but we drop here too in case only the key/model changed.)
		this._planner = undefined;
		// Abort any in-flight planner round-trip bound to the OLD provider/key,
		// so the response (built against stale credentials) cannot resolve onto
		// the post-save state. The ask()/rejectPlan catch blocks treat
		// AbortError as a silent drop, matching clear() semantics.
		this._planAbort?.abort();
		this._planAbort = undefined;
		try {
			const k = GeoChatBotElement._STORAGE_KEYS;
			localStorage.setItem(k.provider, detail.provider);
			if (this.persistApiKey) {
				localStorage.setItem(k.apiKey, detail.apiKey);
			} else {
				try {
					localStorage.removeItem(k.apiKey);
				} catch {
					/* ignore */
				}
			}
			localStorage.setItem(k.model, detail.model);
			localStorage.setItem(
				k.dangerouslyAllowBrowser,
				detail.dangerouslyAllowBrowser ? "1" : "0",
			);
			if (detail.agenticMode)
				localStorage.setItem(k.agenticMode, detail.agenticMode);
			if (detail.retrievalMode)
				localStorage.setItem(k.retrievalMode, detail.retrievalMode);
			if (typeof detail.memoryEnabled === "boolean")
				localStorage.setItem(k.memoryEnabled, detail.memoryEnabled ? "1" : "0");
		} catch {
			// Persistence is best-effort; in-memory state above is authoritative.
		}
		this._settingsOpen = false;
	};

	private _onClearMemoryFromDrawer = (): void => {
		// Fire-and-forget; surface failures only on the public clearMemory()
		// promise (callers who want the result use the public API).
		void this.clearMemory();
	};

	private _openSettings = () => {
		this._settingsOpen = true;
	};
	private _closeSettings = () => {
		this._settingsOpen = false;
	};

	/** Open the upload popover when the panel-footer "Add data" button is clicked. */
	private _onAddDataClicked = (): void => {
		this._uploadOpen = true;
	};

	/** Toggle a layer's visibility (Slice 2 will wire to <gcb-map> filter). */
	private _onLayerToggle = (e: CustomEvent<{ id: string }>): void => {
		const id = e.detail.id;
		this._derivedLayers = this._derivedLayers.map((l) =>
			l.id === id ? { ...l, visible: !l.visible } : l,
		);
	};

	/**
	 * Resolve the effective theme. Used by the topbar toggle to flip between
	 * light/dark — `auto` resolves against `prefers-color-scheme`.
	 */
	private _resolvedTheme(): "light" | "dark" {
		if (this.theme === "light" || this.theme === "dark") return this.theme;
		return typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	}

	/**
	 * AUDIT-K2 (2026-05-11): cycle theme auto → light → dark → auto and
	 * persist to localStorage so the setting survives reload.
	 *
	 * Previously the toggle just bounced between light and dark, so a
	 * user who wanted "follow OS" could never get back to auto without
	 * editing markup. Three-state cycle matches the audit's B2 spec.
	 */
	private _toggleTheme = (): void => {
		const next: ThemeMode =
			this.theme === "auto"
				? "light"
				: this.theme === "light"
					? "dark"
					: "auto";
		this.theme = next;
		try {
			localStorage.setItem(GeoChatBotElement._STORAGE_KEYS.theme, next);
		} catch {
			// localStorage unavailable — toggle still works in-memory.
		}
	};

	private _onSaveSelect = (e: CustomEvent<string>): void => {
		const id = e.detail;
		this._activeSaveId = id;
		this._activeTab = "detail";
		// Replay the saved payload as a new turn in the canvas so a click in
		// the rail produces a visible "I just opened this saved result"
		// outcome. The save's payload is exactly a ResultPayload; the
		// outer SavedResultV1.kind ("map") is metadata for the rail icon
		// and is unrelated to the payload's own discriminator ("layer").
		const save = this.saves.get(id);
		if (!save) return;
		const payload = save.payload as { kind?: string } | undefined;
		// Defensive: corrupt or hand-edited localStorage may yield payloads
		// without a kind discriminator. Drop those silently rather than
		// crashing the canvas; the rail row stays selected as a hint.
		if (
			!payload ||
			(payload.kind !== "layer" &&
				payload.kind !== "chart" &&
				payload.kind !== "table" &&
				payload.kind !== "summary")
		) {
			return;
		}
		if (this.shadowRoot) {
			const canvas = this.shadowRoot.querySelector("result-canvas") as
				| (HTMLElement & {
						beginTurn(q: string): void;
						setResult(p: ResultPayload): void;
				  })
				| null;
			if (canvas) {
				canvas.beginTurn(`Saved: ${save.title}`);
				canvas.setResult(save.payload as ResultPayload);
			}
		}
	};

	/**
	 * Compute why the chat input is disabled, or null when ready. The
	 * <gcb-ask-input> renders an empty-state CTA based on this so the
	 * user never wonders why the box is greyed out.
	 */
	private _askDisabledReason(): AskInputDisabledReason {
		if (this.loaded.length === 0) return "no-data";
		if (!this._apiKey) return "no-key";
		return null;
	}

	private _exampleQuestions(): string[] {
		if (this.loaded.length === 0) return [];
		const names = this.loaded.map((r) => r.name);
		const first = names[0] ?? "";
		const hasGeom = this.loaded.some((r) => !!r.geometry);
		const out = [`How many rows are in ${first}?`, `Show a chart of ${first}.`];
		if (hasGeom) out.push(`Map the ${first} layer.`);
		return out;
	}

	/**
	 * Dedicated handler for the `gcb:clarify-answer` event fired by
	 * <gcb-ask-input> when the user answers the model's ask_user question.
	 * Resolves `_pendingClarification` and updates the status line — that's
	 * ALL it does. It never touches _agentBusy, never sets up a new ask()
	 * lifecycle, never runs a finally block. The original _onAskFromInput
	 * call (still suspended at `await this.ask(originalQuestion)`) stays in
	 * charge of _agentBusy for the full duration, even across multiple
	 * clarification rounds.
	 */
	private _onClarifyAnswer = (e: Event) => {
		const answer = (e as CustomEvent<string>).detail;
		if (!answer || !this._pendingClarification) return;
		this._statusLine = "Continuing analysis…";
		const { resolve } = this._pendingClarification;
		this._pendingClarification = undefined;
		resolve(answer);
	};

	private _onAskFromInput = async (e: Event) => {
		const q = (e as CustomEvent<string>).detail;
		if (!q || this._agentBusy) return;
		this._agentBusy = true;
		this._statusLine = "Thinking…";
		const gen = this.generation;
		try {
			await this.ask(q);
			// After the planner resolves, the plan-review modal is mounted
			// and the user must approve/reject/dismiss before the turn ends.
			// Hold busy across that interaction and the subsequent execution
			// so a second Enter cannot fire a concurrent ask() (which would
			// either trip PLAN_PENDING silently or — once the modal is gone
			// after approve — race the executor on the same canvas).
			//
			// Polling on Lit reactive state avoids a complex promise registry
			// in the rejectPlan/_cancelPendingPlanByDismiss paths. The poll is
			// light (100ms) and bounded by user attention; clear()/disconnect
			// bumps `generation` so we drop out of the wait promptly.
			while (gen === this.generation && this._pendingPlan) {
				await new Promise((r) => setTimeout(r, 100));
			}
			if (gen !== this.generation) return;
			// approvePlan() set __lastExecution; await it so the input stays
			// disabled while runners write to the canvas. Errors are surfaced
			// via 'error' events, so we swallow rejections here.
			const exec = this.__lastExecution;
			if (exec) await exec.catch(() => undefined);
		} finally {
			this._agentBusy = false;
			this._statusLine = "";
		}
	};

	render() {
		if (this.mode === "headless") return html``;
		const disabledReason = this._askDisabledReason();
		const isDark = this._resolvedTheme() === "dark";
		return html`
      <gcb-shell
        .activeTab=${this._activeTab}
        .datasetCount=${this.loaded.length}
        .savedCount=${this._savesList.length}
        @gcb:tab=${(e: CustomEvent<ShellTab>) => {
					this._activeTab = e.detail;
				}}
      >
        <!-- TOPBAR -->
        <div slot="topbar" class="tb-row">
          <div class="tb-rail-spacer" aria-hidden="true"></div>

          <div class="logo-mark" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1L11 4.5v3L6 11 1 7.5v-3L6 1Z" fill="currentColor" fill-opacity=".9"/>
            </svg>
          </div>
          <span class="logo-text">GeoChatBot</span>

          ${
						this._maskedKey
							? html`<span class="status-chip" title="API key configured">
                <span class="dot"></span>${this._providerLabel()} · ${this._maskedKey}
              </span>`
							: html`<span class="status-chip" title="No API key set" style="background:transparent;border-color:var(--gcb-line);color:var(--gcb-ink-muted);">
                <span class="dot" style="background:var(--gcb-ink-dim);animation:none;"></span>not connected
              </span>`
					}

          <div class="tb-gap"></div>

          <!-- Theme toggle -->
          <button
            class="tb-icon-btn"
            type="button"
            aria-label="Toggle light or dark theme"
            title=${isDark ? "Switch to light" : "Switch to dark"}
            @click=${this._toggleTheme}
          >
            ${
							isDark
								? html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
								: html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
						}
          </button>

          <!-- Settings -->
          <button
            class="tb-icon-btn"
            type="button"
            aria-label="Open settings"
            title="Settings"
            @click=${this._openSettings}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
        </div>

        <!-- ICON RAIL -->
        <nav slot="iconRail" class="ir" aria-label="Workspace navigation">
          <button
            class="ir-btn ${this._activeTab === "map" ? "active" : ""}"
            type="button"
            aria-label="Map view"
            title="Map view"
            @click=${() => {
							this._activeTab = "map";
						}}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
              <line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>
            </svg>
          </button>
          <button
            class="ir-btn ${this._activeTab === "results" ? "active" : ""}"
            type="button"
            aria-label="Chat"
            title="Chat"
            @click=${() => {
							this._activeTab = "results";
						}}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </button>
          <button
            class="ir-btn"
            type="button"
            aria-label="Saved results"
            title="Saved results"
            @click=${() => {
							this._activeTab = "detail";
						}}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
            </svg>
          </button>
          <div class="ir-gap"></div>
          <button
            class="ir-btn"
            type="button"
            aria-label="Settings"
            title="Settings"
            @click=${this._openSettings}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
        </nav>

        <!-- CONTENTS PANEL -->
        <gcb-rail
          slot="rail"
          .datasets=${this.loaded.map((r) => ({
						name: r.name,
						rows: this.profiles[r.name]?.rowCount ?? r.table.numRows,
						hasGeometry: !!r.geometry,
					}))}
          .saves=${this._savesList}
          .layers=${this._derivedLayers}
          .activeSaveId=${this._activeSaveId}
          @gcb:save-select=${this._onSaveSelect}
          @gcb:save-remove=${(e: CustomEvent<string>) => this.saves.remove(e.detail)}
          @gcb:dataset-toggle=${() => {
						/* visibility toggle handled by host map renderer */
					}}
          @gcb:layer-toggle=${this._onLayerToggle}
          @gcb:add-data=${this._onAddDataClicked}
        ></gcb-rail>

        <!-- MAIN: chat history -->
        <div slot="main" style="height:100%; overflow:hidden; display:flex; flex-direction:column;"
          @gcb:save-result=${this._onSaveResult}>
          ${this.error ? html`<div class="err">${this.error}</div>` : null}
          <!-- ── Floating status bar (visible whenever the agent is busy) ── -->
          ${
						this._agentBusy && this._statusLine
							? html`<div style="
                  display:flex;
                  align-items:center;
                  gap:10px;
                  padding:10px 16px;
                  background:var(--gcb-accent-soft-bg,#f5f3ff);
                  border-bottom:1px solid var(--gcb-accent,#4338ca)33;
                  font-size:13px;
                  color:var(--gcb-accent,#4338ca);
                  font-weight:500;
                  flex-shrink:0;
                ">
                  <!-- pulsing spinner -->
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
                    style="animation:gcb-spin 1s linear infinite;flex-shrink:0">
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${this._statusLine}
                  </span>
                  ${
										this._statusLine.includes("Geocoding")
											? html`<span style="font-size:11px;opacity:.7;font-weight:400;flex-shrink:0;">
                          US addresses use Census batch geocoder (fast); other addresses use Nominatim (1 req/s)
                        </span>`
											: null
									}
                </div>`
							: null
					}
          <result-canvas style="flex:1; min-height:0;"></result-canvas>
          <!-- Upload popover anchored under the topbar — opens via Add data button -->
          ${
						this._uploadOpen
							? html`<div style="position:absolute;top:50px;right:20px;z-index:50;">
                <gcb-upload-popover
                  ?open=${this._uploadOpen}
                  @gcb:files=${this._onFilesFromPopover}
                  @gcb:popover-close=${() => {
										this._uploadOpen = false;
									}}
                ></gcb-upload-popover>
              </div>`
							: null
					}
        </div>

        <!-- DOCK: chat input. max-height + overflow lets the dock scroll
             internally in the rare case its content exceeds 40vh; the
             shell's fit-content(40vh) dock track sizes to this content. -->
        <div slot="dock" style="display:flex; align-items:center; padding: 0 14px; max-height:40vh; overflow-y:auto;">
          <gcb-ask-input
            style="flex:1;"
            .disabledReason=${disabledReason}
            .examples=${disabledReason === null && !this._pendingClarification ? this._exampleQuestions() : []}
            ?busy=${this._agentBusy && !this._pendingClarification}
            .clarifyQuestion=${this._pendingClarification?.question ?? null}
            @gcb:ask=${this._onAskFromInput}
            @gcb:clarify-answer=${this._onClarifyAnswer}
            @gcb:request-settings=${this._openSettings}
          ></gcb-ask-input>
        </div>
      </gcb-shell>

      ${
				this._settingsOpen
					? html`<gcb-settings-drawer
            .value=${
							{
								provider: this._llmProvider,
								model: this._model,
								apiKey: this._apiKey ?? "",
								dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
								agenticMode: this.agenticMode,
								retrievalMode: this.retrievalMode,
								memoryEnabled: this.memoryEnabled,
							} as SettingsValue
						}
            @gcb:settings=${this._onSaveSettings}
            @gcb:settings-close=${this._closeSettings}
            @gcb:clear-memory=${this._onClearMemoryFromDrawer}
          ></gcb-settings-drawer>`
					: null
			}
    `;
	}

	/* -------------------------------------------------------------------- */
	/* Public API                                                           */
	/* -------------------------------------------------------------------- */

	/**
	 * Inline-rows ingest payload for the headless contract (PLAN.md §2):
	 *
	 *   bot.pushData({ name: 'sales', rows: [...], geometry: {...} })
	 *
	 * Builds an Apache Arrow table from `rows` and runs the full ingest
	 * path (DuckDB registration, profiling, `dataset-loaded` event, and
	 * — most importantly — `_execDatasets` binding so subsequent `ask()`
	 * calls have a real DuckDB view to query against).
	 */
	// public for typedoc + tests; not exported from index.
	// (No JSDoc on the type — kept inline so a single grep finds the contract.)

	/**
	 * Ingest data through the same pipeline used by drag-drop / picker.
	 *
	 * Accepts four shapes:
	 *  - {@link File} — browser file
	 *  - `{ name, bytes }` — pre-loaded binary
	 *  - `{ name, rows, geometry?, source? }` — inline JS rows (headless dashboards)
	 *  - {@link PlannerDatasetProfile} — planner-side metadata only (tests, stubs)
	 *
	 * Always resolves; ingest failures are surfaced via the `error` event
	 * and the component's error banner rather than thrown.
	 */
	async pushData(
		input:
			| File
			| { name: string; bytes: Uint8Array | ArrayBuffer }
			| {
					name: string;
					rows: ReadonlyArray<Record<string, unknown>>;
					geometry?: GeometryEncoding;
					source?: SourceFormat;
			  }
			| PlannerDatasetProfile,
	): Promise<void> {
		// (1) Inline-rows ingest — must come BEFORE the profile-shape check
		// because both shapes have a `rows` field. The discriminator is
		// Array.isArray(rows): planner profile uses rows: number, this path
		// uses rows: array.
		if (
			input &&
			typeof input === "object" &&
			!("bytes" in input) &&
			"rows" in (input as object) &&
			Array.isArray((input as { rows: unknown }).rows)
		) {
			const rowsInput = input as {
				name: string;
				rows: ReadonlyArray<Record<string, unknown>>;
				geometry?: GeometryEncoding;
				source?: SourceFormat;
			};
			await this._ingestRows(rowsInput);
			return;
		}
		// (2) Planner-only profile shape (tests, post-ingest re-pushes).
		if (
			input &&
			typeof input === "object" &&
			!("bytes" in input) &&
			"kind" in input &&
			"columns" in input &&
			"rows" in input
		) {
			// Defensive copy + drop the `sample` field. Caller-supplied sample
			// rows are concatenated verbatim into the planner system prompt by
			// `renderDatasetsBlock` and would let a hostile dataset inject text
			// shaped like new tool definitions or instructions ("ignore previous
			// …"). The internal file-drop path already sets sample: [] via
			// toPlannerDatasetProfile; this branch is the remaining ingress and
			// we treat caller `sample` as untrusted.
			const incoming = input as PlannerDatasetProfile;
			this._datasets.push({ ...incoming, sample: [] });
			return;
		}
		// (3) Binary input — File or { bytes }.
		const binary: BinaryInput =
			typeof File !== "undefined" && input instanceof File
				? input
				: (input as { name: string; bytes: Uint8Array | ArrayBuffer });
		await this.ingest(binary);
	}

	/**
	 * Build an Arrow table from inline JS rows and run it through the full
	 * ingest pipeline. Used by the headless `pushData({ rows })` overload
	 * so a host page can hand us in-memory data without serialising to a
	 * binary format first.
	 *
	 * Engine registration is best-effort just like the binary path: if the
	 * DuckDB-WASM Worker is not available (test envs, hardened CSP), we
	 * still publish the dataset to the planner side so `ask()` works
	 * against a stubbed engine.
	 */
	private async _ingestRows(input: {
		name: string;
		rows: ReadonlyArray<Record<string, unknown>>;
		geometry?: GeometryEncoding;
		source?: SourceFormat;
	}): Promise<void> {
		const gen = this.generation;
		this.busy = true;
		this.error = null;
		try {
			if (!input.rows.length) {
				throw new Error("pushData({ rows }): rows array is empty");
			}
			const table = tableFromJSON(input.rows as Array<Record<string, unknown>>);
			const result: LoadResult = {
				name: input.name,
				table,
				source: input.source ?? "csv",
				filename: `${input.name}.json`,
				...(input.geometry ? { geometry: input.geometry } : {}),
			};
			if (gen !== this.generation) return;

			const profile = profileDataset(result);
			this.profiles = { ...this.profiles, [result.name]: profile };

			let engineRegistered = false;
			try {
				const engine = getEngine();
				await engine.init();
				const reg = await engine.registerArrow(result);
				engineRegistered = true;
				// Critical: bind the DuckDB view to the executor's dataset map
				// so the agent loop can resolve `${dataset}` references. This
				// closes the headless-mode gap where pushData({rows}) used to
				// create only a planner-side stub and the executor would throw
				// "unknown dataset" for any step that touched the data.
				this._execDatasets = [
					...this._execDatasets.filter((d) => d.name !== result.name),
					{
						name: result.name,
						tableName: reg.tableName,
						...(reg.geomView ? { geomView: reg.geomView } : {}),
						hasGeometry: !!reg.geomView,
					},
				];
			} catch (err) {
				// Pass only the error code — never the raw Error object, whose
				// `message` / `cause` may carry the request URL or auth header
				// for any provider/network failure that bubbled into engine init.
				// eslint-disable-next-line no-console
				console.warn(
					"[geochatbot] engine registration failed for inline rows; planner-only mode",
					errCode(err),
				);
			}

			if (gen !== this.generation) return;

			// Mirror to the planner-side dataset map so the LLM sees this dataset.
			const plannerProfile = toPlannerDatasetProfile(result.name, profile);
			this._datasets = [
				...this._datasets.filter((d) => d.name !== result.name),
				plannerProfile,
			];

			this.loaded = [...this.loaded, result];
			this.dispatch("dataset-loaded", {
				name: result.name,
				source: result.source,
				profile,
				engineRegistered,
			});
		} catch (err) {
			const message = errMessage(err);
			this.error = message;
			this.dispatch("error", { message, code: errCode(err) });
		} finally {
			if (gen === this.generation) this.busy = false;
		}
	}

	/**
	 * Wipe the user-memory store (questions + plans persisted via
	 * `memoryEnabled`). Static corpus and example RAG are unaffected.
	 *
	 * Surfaces as `clearMemory()` on the public element API so a host can
	 * wire a "Forget my history" button into a parent menu. The widget's
	 * own settings drawer also calls this.
	 */
	async clearMemory(): Promise<void> {
		await clearUserMemory();
	}

	/** Set the active LLM provider used by future agent turns. */
	setProvider(provider: ChatProvider): void {
		this.provider = provider;
		setActiveProvider(provider);
		// Phase 4: stash key+model for the Planner. The base ChatProvider type
		// does not carry these fields, but the concrete Anthropic/Gemini/OpenAI
		// option objects do — read them through a structural narrowing rather
		// than `as any`.
		const opts = provider as {
			apiKey?: unknown;
			model?: unknown;
			name?: unknown;
			id?: unknown;
		};
		// Sync the internal provider id so agentic-mode endpoint selection,
		// agentic/single-shot routing, and the error-message provider label
		// all reflect the host's choice. Hosts pass the public
		// `{ name: 'anthropic'|'groq'|'openai'|'gemini', apiKey, model }`
		// shape (documented in PLAN.md §dev API and used by every e2e
		// spec); the typed ChatProvider interface uses `id`, so accept
		// either. Without this sync, `_llmProvider` keeps its constructor
		// default ("groq") and `<geo-chatbot agentic-mode="agentic">` with
		// an Anthropic provider mistakenly drives the agentic loop against
		// Groq's /chat/completions endpoint.
		const providerKey =
			typeof opts.name === "string" && opts.name
				? opts.name
				: typeof opts.id === "string" && opts.id
					? opts.id
					: undefined;
		if (
			providerKey &&
			GeoChatBotElement._KNOWN_PROVIDERS.has(providerKey as ProviderId)
		) {
			this._llmProvider = providerKey as ProviderId;
		}
		if (typeof opts.apiKey === "string" && opts.apiKey)
			this._apiKey = opts.apiKey;
		if (typeof opts.model === "string" && opts.model) this._model = opts.model;
		// Reset planner so the next ask() rebuilds with the new key.
		this._planner = undefined;
	}

	/** Test-only: substitute the LLM call for deterministic tests. */
	__setLlmCall(
		fn: (input: PlannerLLMInput) => Promise<Record<string, unknown>>,
	): void {
		this._llmCall = fn;
		this._planner = undefined; // force rebuild with stub on next ask()
	}

	/** Currently active provider, if any. Exposed for tests / introspection. */
	getProvider(): ChatProvider | undefined {
		return this.provider;
	}

	/**
	 * Switch between full UI and headless (events-only) rendering. Equivalent
	 * to setting the `mode` attribute / property; provided as a method so
	 * imperative consumers can toggle without touching attributes.
	 */
	setMode(mode: GeoChatBotMode): void {
		this.mode = mode;
	}

	/**
	 * Phase 4: Ask the agent a question. Builds (or reuses) a Planner, calls
	 * the LLM, validates the returned Plan, and dispatches a `plan` event.
	 * The plan is held pending until {@link approvePlan} or {@link rejectPlan}.
	 */
	async ask(question: string): Promise<void> {
		this._lastQuestion = question.trim();
		// Begin a new chat turn so the user's question shows immediately as a
		// bubble, even before the planner returns.
		if (this.mode !== "headless" && this._lastQuestion) {
			this._beginCanvasTurn(this._lastQuestion);
		}
		if (typeof question !== "string" || !question.trim()) {
			// Empty / whitespace-only questions otherwise reach Anthropic and
			// get an opaque HTTP 400 response. Surface a clean code so the
			// host UI can show a clear "type something first" message.
			this.dispatch("error", {
				code: "EMPTY_QUESTION",
				message: "ask(question) requires a non-empty string",
			});
			return;
		}
		if (!this._apiKey) {
			this.dispatch("error", {
				code: "NO_KEY",
				message: "No provider configured",
			});
			return;
		}
		// H4: Refuse to plan over a still-pending plan. Without this guard a
		// second `ask()` silently overwrites `_pendingPlan`, the user loses
		// the ability to approve plan #1, and any progress/result events
		// that did fire become orphaned. Hosts must explicitly resolve the
		// first plan (approve / reject) before calling ask() again.
		if (this._pendingPlan) {
			this.dispatch("error", {
				planId: this._pendingPlan.id,
				code: "PLAN_PENDING",
				message:
					"A plan is awaiting approval; call approvePlan/rejectPlan before ask() again.",
			});
			return;
		}
		// The browser-direct guard in agent/llm.ts is intentional. The widget
		// honors it by routing the host's explicit opt-in via the
		// `dangerouslyAllowBrowser` property (default false). When the test-only
		// llmCall is installed, the guard does not apply because the call never
		// reaches `callPlannerLLM`.
		if (!this._llmCall && !this.dangerouslyAllowBrowser) {
			this.dispatch("error", {
				code: "BROWSER_KEY_GUARD",
				message: `Direct-from-browser ${this._providerLabel()} calls leak the API key. Set the \`dangerously-allow-browser\` attribute (or .dangerouslyAllowBrowser=true) to acknowledge, or proxy through your own server.`,
			});
			return;
		}
		if (!this._planner) {
			// Build the inspection-context for agentic mode lazily — it depends
			// on the executor engine, which is shared with the regular plan
			// execution path. We build it here so the planner picks it up on
			// first use; subsequent `ask()` calls reuse the same Planner.
			const agenticCtx = this._buildAgenticCtx();
			const agenticEndpoint = this._agenticEndpointForActiveProvider();
			const wantAgentic = this.agenticMode === "agentic";
			const agenticActive = wantAgentic && !!agenticEndpoint && !!agenticCtx;
			// If the host asked for agentic mode but it can't be honored
			// (Anthropic / Gemini providers, or no engine yet), surface a
			// warning event so the host UI can show a one-line note instead
			// of the user wondering why the inspection trace never appears.
			// Re-fired on every Planner rebuild so attribute toggles get
			// immediate feedback.
			if (wantAgentic && !agenticActive) {
				const reason = !agenticEndpoint
					? `agentic mode is not supported for provider "${this._llmProvider}" — falling back to single-shot. Use Anthropic (Claude), OpenAI, or Groq for the multi-turn loop.`
					: "agentic mode requires a loaded dataset (the inspection tools query DuckDB) — falling back to single-shot until you add data.";
				// Dispatch as a non-blocking warning so the host can surface it
				// in a toast/banner without aborting the user's question.
				this.dispatch("error", { code: "AGENTIC_FALLBACK", message: reason });
			}
			// For Anthropic, inject the native-format loop adapter so the
			// agentic ReAct loop calls Anthropic's Messages API directly
			// instead of an OpenAI-compat endpoint.
			const anthropicAgenticCall =
				agenticActive && this._llmProvider === "anthropic"
					? makeAnthropicLoopCall()
					: undefined;
			this._planner = new Planner({
				provider: this._llmProvider,
				apiKey: this._apiKey,
				model: this._model,
				dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
				...(this._llmCall ? { llmCall: this._llmCall } : {}),
				...(anthropicAgenticCall
					? { agenticLlmCall: anthropicAgenticCall }
					: {}),
				mode: agenticActive ? "agentic" : "single-shot",
				retrieval: this.retrievalMode,
				memoryEnabled: this.memoryEnabled,
				...(agenticEndpoint ? { agenticEndpoint } : {}),
				...(agenticCtx ? { agenticCtx } : {}),
				// Stream the agent's reasoning to the host AND to the built-in
				// chat canvas so users see the bot "thinking" in real time.
				// Without this, agentic mode is a 30-second silent stare at
				// "Thinking…" — exactly what the user complained about.
				onAgenticStep: (e) => {
					this.dispatch("agentic-step", e as GeoChatBotEvents["agentic-step"]);
					if (this.mode !== "headless") this._pushAgenticThought(e);
					// Keep the status line current during the agentic reasoning loop.
					if (e.kind === "reason") this._statusLine = "Analyzing your data…";
					else if (e.kind === "tool")
						this._statusLine = `Inspecting: ${e.toolId}…`;
					else if (e.kind === "clarify-needed")
						this._statusLine = "Waiting for your answer…";
					else if (e.kind === "finalize")
						this._statusLine = "Plan ready — preparing to run…";
				},
				onAgenticClarify: (question, signal) =>
					new Promise<string>((resolve, reject) => {
						// Surface the question in the widget UI and store the
						// resolve so the user's next Ask input feeds back here.
						this._pendingClarification = { question, resolve };
						// If the abort signal fires before the user answers,
						// clean up and reject so the loop tears down cleanly.
						const onAbort = (): void => {
							this._pendingClarification = undefined;
							reject(new DOMException("AbortError", "AbortError"));
						};
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
			});
		}
		// Capture the generation BEFORE awaiting the planner. If `clear()`
		// (which bumps generation) runs while the planner LLM call is in
		// flight, the resolved plan belongs to a session that no longer
		// exists — we must not set `_pendingPlan` or mount a plan-review on
		// a cleared widget. Multi-tenant correctness: a stale plan from a
		// previous user/session would otherwise be approvable in the new
		// session.
		const gen = this.generation;
		// Per-call AbortController so clear()/disconnect() can cancel the
		// in-flight planner LLM call. Replace any prior controller; the only
		// concurrent ask() path is gated above by `_pendingPlan`, but a
		// settings-save during planning explicitly aborts via _planAbort.
		this._planAbort?.abort();
		const planAbort = new AbortController();
		this._planAbort = planAbort;
		try {
			const plan = await this._planner.plan({
				question,
				datasets: this._datasets,
				signal: planAbort.signal,
			});
			if (gen !== this.generation) return; // clear() ran during the planner call
			const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			this._pendingPlan = { id, plan };
			this.dispatch("plan", { planId: id, plan, datasets: this._datasets });
			this._renderPlanIfFull();
		} catch (err) {
			if (gen !== this.generation) return; // clear() ran; suppress error from stale session
			// Native AbortError from clear()/disconnect/settings-save: silently drop.
			if (err instanceof Error && err.name === "AbortError") return;
			this.dispatch("error", {
				code: errCode(err),
				message: errMessage(err, "plan failed"),
			});
		} finally {
			if (this._planAbort === planAbort) this._planAbort = undefined;
		}
	}

	approvePlan(id?: string): void {
		if (!this._pendingPlan) return;
		if (id !== undefined && id !== this._pendingPlan.id) return;
		const { plan, id: planId } = this._pendingPlan;
		this._pendingPlan = undefined;
		// Capture the execution promise so test code can deterministically
		// await completion. Intentional fire-and-forget at runtime — the
		// host doesn't await approvePlan; events are the public contract.
		this.__lastExecution = this._execute(planId, plan);
		void this.__lastExecution;
	}

	/**
	 * Test-only: the promise of the most recent `_execute` invocation, or
	 * undefined before any plan has been approved. Lets tests
	 * `await el.__lastExecution` instead of busy-polling on event order.
	 */
	__lastExecution: Promise<void> | undefined;

	rejectPlan(opts?: { id?: string; feedback?: string }): void {
		if (!this._pendingPlan) return;
		if (opts?.id !== undefined && opts.id !== this._pendingPlan.id) return;
		const { id: planId, plan } = this._pendingPlan;
		this._pendingPlan = undefined;
		this.dispatch("progress", { planId, status: "rejected" });
		if (!this._planner) {
			this.dispatch("error", {
				planId,
				code: "NO_PLANNER",
				message: "rejectPlan called with no active planner",
			});
			return;
		}
		// Same generation guard as ask(): the rephrase planner call is
		// in-flight when clear() can race in. Without the gen check, the
		// newPlan would land in a cleared widget, mount a plan-review, and
		// the previous-session plan would become approvable.
		const gen = this.generation;
		const replanQ =
			this._lastQuestion.trim() !== "" ? this._lastQuestion : plan.goal;
		// Per-call AbortController so clear()/disconnect/settings-save can
		// cancel the rephrase round-trip. See ask() for the parallel pattern.
		this._planAbort?.abort();
		const planAbort = new AbortController();
		this._planAbort = planAbort;
		void this._planner
			.plan({
				question: replanQ,
				datasets: this._datasets,
				feedback: opts?.feedback ?? "rejected by user",
				signal: planAbort.signal,
			})
			.then((newPlan) => {
				if (gen !== this.generation) return; // clear() ran during rephrase
				const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
				this._pendingPlan = { id, plan: newPlan };
				this.dispatch("plan", {
					planId: id,
					plan: newPlan,
					datasets: this._datasets,
				});
				this._renderPlanIfFull();
			})
			.catch((err) => {
				if (gen !== this.generation) return; // clear() ran; drop stale-session error
				if (err instanceof Error && err.name === "AbortError") return;
				this.dispatch("error", {
					code: errCode(err),
					message: errMessage(err),
				});
			})
			.finally(() => {
				if (this._planAbort === planAbort) this._planAbort = undefined;
			});
	}

	/**
	 * Modal dismissed (Esc / scrim) — drop the pending plan without calling
	 * the LLM again. Distinct from {@link rejectPlan}, which requests a new plan.
	 */
	private _cancelPendingPlanByDismiss(planId: string): void {
		if (!this._pendingPlan || this._pendingPlan.id !== planId) return;
		const pid = this._pendingPlan.id;
		this._pendingPlan = undefined;
		this.dispatch("progress", { planId: pid, status: "cancelled" });
	}

	/**
	 * Phase 5: real executor. Pre-validates every `sql` step at the §4
	 * boundary (defense-in-depth — the runner re-validates too), then
	 * runs the plan via a main-thread Executor against the existing
	 * DuckDB-WASM engine. Worker-via-Comlink is wired in
	 * `agent/executor/client.ts` and ships in Phase 5 expansion when
	 * the engine is moved off the main thread.
	 */
	private async _execute(
		planId: string,
		plan: Plan,
		attempt = 1,
	): Promise<void> {
		// Pre-validate every `sql` step at the §4 boundary. This is an
		// early-rejection convenience for fast UI feedback only — the
		// canonical gate is `runners/sql.ts`, which validates every SQL
		// body on each call (including critic-patched steps that re-enter
		// the executor mid-flight in Phase 6).
		for (const step of plan.steps) {
			if (step.tool === "sql") {
				try {
					validateSql((step.args as { query?: unknown })?.query as string);
				} catch (err) {
					const message = errMessage(err);
					this.dispatch("error", {
						planId,
						stepId: step.id,
						code: "SQL",
						message,
					});
					this.dispatch("progress", {
						planId,
						stepId: step.id,
						status: "fail",
						error: message,
					});
					return;
				}
			}
		}

		const engine = this._resolveExecutorEngine();
		if (!engine) {
			this.dispatch("error", {
				planId,
				code: "NO_ENGINE",
				message: "DuckDB engine unavailable in this environment.",
			});
			return;
		}

		// H1: Clear stale renderer panels before every execution. Without
		// this, run #2 visually inherits run #1's chart/table/map/summary
		// panels for any kind it does not re-emit. The canvas may not
		// exist yet (full mode lazily mounts; headless never mounts) — a
		// null-safe call on the optional `clear` keeps both paths working.
		if (this.mode !== "headless" && this.shadowRoot) {
			const canvas = this.shadowRoot.querySelector("result-canvas") as
				| (HTMLElement & { clear?: () => void })
				| null;
			canvas?.clear?.();
			// Re-open the original question turn so the canvas never shows
			// "Ask a question" blank state while the executor is running.
			if (this._lastQuestion) this._beginCanvasTurn(this._lastQuestion);
		}

		// AUDIT-W (2026-05-11) — execution-path decision recorded:
		//   We deliberately call the in-process Executor here even though
		//   `agent/executor/client.ts` exposes a worker-backed alternative
		//   (`createWorkerExecutor`) for environments where
		//   `canUseExecutorWorker()` returns true.
		//
		//   Why in-process is the default:
		//   1. DuckDB-WASM already runs in its OWN worker (the
		//      @duckdb/duckdb-wasm package spawns one internally) — the
		//      bulk of CPU + I/O is therefore already off the main thread.
		//   2. The executor's main-thread work is plan-step orchestration
		//      (resolve var refs, call runner, emit progress events). That
		//      work is small (μs per step) and benefits little from a
		//      second worker hop. Moving it would also DOUBLE the Arrow
		//      IPC traffic (main → executor-worker → DuckDB-worker).
		//   3. The worker path adds two cross-thread postMessage hops per
		//      runner call, which slows small plans noticeably on
		//      lower-spec hardware.
		//
		//   The worker module + test/agent/executor/worker-abort.test.ts
		//   remain as an opt-in surface for future use cases that DO need
		//   long-running CPU-bound work isolated from the main thread.
		const exec = new Executor({
			engine,
			datasets: this._execDatasets,
			...(this._datasets.length === 1
				? { activeProfile: this._datasets[0] }
				: {}),
		});
		const critic = this._buildCritic();
		// Fresh controller per execution. clear() / a new ask() before this
		// run completes will fire abort(); the signal is forwarded to every
		// critic.diagnose() call so an in-flight Anthropic fetch can be torn
		// down promptly instead of running to completion in the background.
		const abort = new AbortController();
		this._execAbort = abort;
		// Reliable loop: collect rendered results so we can verify the
		// OUTCOME (not just per-step success) once execution finishes, and
		// note whether a terminal error already fired (those are surfaced via
		// onError → friendlyExecError and must not trigger outcome-recovery).
		const collectedResults: ResultPayload[] = [];
		let sawError = false;
		let execErrorMsg: string | undefined;
		try {
			await exec.execute(
				plan,
				planId,
				{
					onProgress: (e: ExecProgressEvent) => {
						this.dispatch("progress", e);
						if (this.mode !== "headless") this._pushPlanStatus(e);
						// Update the floating status line with step info.
						if (e.status === "running") {
							const total = plan.steps.length;
							const idx = plan.steps.findIndex((s) => s.id === e.stepId) + 1;
							const tool =
								plan.steps.find((s) => s.id === e.stepId)?.tool ?? e.stepId;
							this._statusLine = `Step ${idx} / ${total} — ${tool}…`;
						} else if (e.status === "success") {
							const remaining = plan.steps.filter(
								(s) =>
									s.id > e.stepId ||
									plan.steps.indexOf(s) >
										plan.steps.findIndex((ss) => ss.id === e.stepId),
							).length;
							if (remaining === 0) this._statusLine = "Rendering result…";
						}
					},
					onSubProgress: (message: string) => {
						this._statusLine = message;
					},
					onResult: (e: ExecResultEvent) => {
						this.dispatch("result", e);
						collectedResults.push(e);
						if (this.mode !== "headless") this._mountResult(e);
					},
					onIntermediate: (e) => {
						// HIGH-04 fix: register the produced layer/table as a
						// planner-visible dataset so the next conversation turn
						// can reference it directly (e.g. "of those, how many
						// completed?") instead of triggering a re-run of the
						// upstream operation.
						void this._registerIntermediateLayer(e.ref, e.outputVar);
					},
					onError: (e) => {
						sawError = true;
						execErrorMsg = e.message;
						this.dispatch("error", e);
						this.error = friendlyExecError(e.message);
					},
					...(critic
						? {
								onStepError: async (ctx: StepErrorContext) => {
									const decision = await critic.diagnose(ctx, abort.signal);
									const detail: GeoChatBotEvents["critic"] = {
										planId: ctx.planId,
										stepId: ctx.step.id,
										attempt: ctx.retryCount + 1,
										maxAttempts: ctx.maxRetries + 1,
										decision: decision.action,
										errorMessage: ctx.error.message,
										beforeArgs: ctx.resolvedArgs,
									};
									if (decision.action === "patch") {
										detail.afterArgs = decision.patchedStep.args;
									}
									this.dispatch("critic", detail);
									if (this.mode !== "headless")
										this._pushCriticAttempt(detail, decision);
									return decision;
								},
							}
						: {}),
				},
				abort.signal,
			);

			// ── Reliable loop: recover from a bad OUTCOME or a recoverable
			// EXECUTION ERROR, else be honest. ────────────────────────────────
			// The single-step critic above patches failing *step args*; this
			// layer re-plans a DIFFERENT strategy when (a) the result the user
			// got is degenerate (empty/one-color map — the gap that let a
			// 306-point all-gray map ship as "success"), or (b) the plan died
			// on a logic-class error (unknown dataset, unimplemented tool, bad
			// column) where a different approach would work. Infra errors are
			// left as the friendly message from onError (re-planning can't fix
			// a proxy/network outage).
			let recoveryFeedback: string | undefined;
			let honestMessage: string | undefined;
			if (abort.signal.aborted) {
				// interrupted — leave as-is
			} else if (sawError && REPLANNABLE_ERROR.test(execErrorMsg ?? "")) {
				// The plan named a tool/dataset/runner that doesn't exist, or a
				// SQL step left an unsubstituted ${var} — a different plan fixes
				// it. (Runtime failures the step-critic owns are left as-is.)
				recoveryFeedback = UNSUBSTITUTED_VAR.test(execErrorMsg ?? "")
					? `Your previous plan FAILED with: "${execErrorMsg}". A SQL step referenced a prior step's output using \${...} syntax, which is NOT substituted inside SQL text. Reference a prior step's output by its bare output_var name as a table (e.g. "FROM my_output"), or pass the layer via a 'layer' argument — never "\${my_output}" inside a query. Re-plan accordingly.`
					: /output_var.*collides|collides with loaded dataset/i.test(
								execErrorMsg ?? "",
							)
						? `Your previous plan FAILED because an output_var name collided with an existing dataset name: "${execErrorMsg}". Choose a completely different output_var — use short generic names like "filtered", "result", "s1_out", "step_out" — never reuse the name of any dataset already loaded. Re-plan with a unique output_var.`
						: `Your previous plan FAILED with this error: "${execErrorMsg}". That tool or dataset is unavailable. Re-plan with a DIFFERENT, simpler approach using ONLY the loaded dataset and basic tools (sql, render.map, render.table, render.chart, stats.aggregate). Do not reference the failing tool or dataset again.`;
				// honestMessage falls back to the friendlyExecError already set.
			} else if (!sawError) {
				const verdict = this._verifyOutcome(collectedResults);
				if (!verdict.ok) {
					// Grounding contradiction → CoVe single-call correction (the
					// computed table is correct; only the prose is wrong, so a
					// full re-plan would be wasteful). If the correction succeeds
					// we rewrite the summary in place and skip re-planning entirely.
					if (verdict.groundingFix && !abort.signal.aborted) {
						const corrected = await this._correctGroundedSummary(
							verdict.groundingFix,
							abort.signal,
						);
						if (corrected && !abort.signal.aborted) {
							this._canvas()?.correctLastSummary(corrected);
							// fixed in place — nothing left to recover
						} else if (!this.error) {
							// CoVe failed → fall back to the honest message so we
							// never silently ship the contradictory summary.
							this.error = verdict.message;
						}
					} else {
						recoveryFeedback = verdict.feedback;
						honestMessage = verdict.message;
					}
				}
			}

			if (recoveryFeedback) {
				const canRecover =
					attempt < RELIABLE_MAX_ATTEMPTS &&
					!!this._planner &&
					this._lastQuestion.trim() !== "";
				if (canRecover) {
					const gen = this.generation;
					this._statusLine =
						"That approach didn't work — retrying with a different strategy…";
					let newPlan: Plan | undefined;
					try {
						newPlan = await this._planner?.plan({
							question: this._lastQuestion,
							datasets: this._datasets,
							feedback: recoveryFeedback,
							signal: abort.signal,
						});
					} catch (err) {
						if (!(err instanceof Error && err.name === "AbortError")) {
							this.error = errMessage(err, "recovery plan failed");
						}
					}
					if (newPlan && gen === this.generation && !abort.signal.aborted) {
						// Only now that we're committing to the retry, clear the
						// failed-attempt error so a stale card doesn't sit behind
						// the (hopefully good) recovered result.
						this.error = null;
						const newId = `plan_${Date.now().toString(36)}_${Math.random()
							.toString(36)
							.slice(2, 8)}`;
						this.dispatch("plan", {
							planId: newId,
							plan: newPlan,
							datasets: this._datasets,
						});
						await this._execute(newId, newPlan, attempt + 1);
					} else if (honestMessage && !this.error) {
						// Couldn't actually retry (planner missing/returned nothing,
						// or session moved on) — fall back to the honest message
						// rather than leaving a degenerate result unexplained.
						this.error = honestMessage;
					}
				} else if (honestMessage) {
					// Out of attempts on a degenerate outcome: explain it (don't
					// silently ship a bad result). Execution errors already show
					// the friendlyExecError from onError.
					this.error = honestMessage;
				}
			}
		} finally {
			// Only clear our reference if THIS execution still owns the controller.
			// A clear() mid-flight may have already swapped in a new one (or
			// aborted ours). Either way, never clobber a successor's controller.
			if (this._execAbort === abort) this._execAbort = undefined;
		}
	}

	/**
	 * Deterministic outcome verification over the results a plan rendered.
	 * Returns `ok: true` when nothing looks degenerate. On failure, `feedback`
	 * is the re-plan directive (injected into the planner) and `message` is the
	 * honest user-facing explanation used when recovery is exhausted.
	 *
	 * Guards are intentionally conservative so they never fire on small,
	 * legitimate results: the color-by degeneracy check only applies at >= 20
	 * features (mirrors computeLegend's own degeneracy threshold), and empty
	 * layers are always flagged.
	 */
	private _verifyOutcome(results: ReadonlyArray<ResultPayload>): {
		ok: boolean;
		feedback: string;
		message: string;
		/**
		 * Set when a summary contradicts the table the same plan computed
		 * (claim-grounding). The table is correct — only the prose is wrong —
		 * so the recovery path is a single CoVe correction call, NOT a re-plan.
		 */
		groundingFix?: {
			table: {
				columns: ReadonlyArray<string>;
				rows: ReadonlyArray<Record<string, unknown>>;
			};
			badSummary: string;
			reason: string;
		};
	} {
		const fails: GuardResult[] = [];
		// Track the most recent table + summary so we can cross-check a
		// summary's superlative/numeric claims against the computed data.
		let lastTable:
			| {
					columns: ReadonlyArray<string>;
					rows: ReadonlyArray<Record<string, unknown>>;
			  }
			| undefined;
		let lastSummary: string | undefined;
		for (const r of results) {
			if (r.kind === "table") lastTable = { columns: r.columns, rows: r.rows };
			if (r.kind === "summary") lastSummary = r.text;
			// render.map falls back to a "Cannot map …" SUMMARY when a step
			// dropped the geometry.  Two distinct sub-cases:
			//
			// A) "… but it does have address-like columns" — the table came from
			//    a SQL step on the raw (un-geocoded) CSV.  Recovery: geocode first,
			//    then SQL on the geocoded output.
			//
			// B) "no geometry column, no lat/lon columns, and no address-like
			//    columns" — the table probably came from a SQL step on a GeoJSON
			//    source that already had geometry, but SELECT dropped it.
			//    Recovery: rewrite the SQL with SELECT * (or explicitly include
			//    the geometry column).
			if (r.kind === "summary" && /cannot map/i.test(r.text)) {
				const hasAddressHint = /address-like columns/i.test(r.text);
				const noGeomNoAddr =
					/no geometry column/i.test(r.text) &&
					/no lat\/lon/i.test(r.text) &&
					/no address-like/i.test(r.text);
				if (noGeomNoAddr) {
					// GeoJSON / polygon source — geometry was dropped by SQL SELECT
					fails.push({
						ok: false,
						severity: "fail",
						reason:
							"map could not render — SQL step dropped the geometry column",
						suggestedFix:
							"rewrite the SQL step to use SELECT * FROM [table] WHERE ... instead of listing specific columns — this preserves the geometry column that render.map needs",
					});
				} else if (hasAddressHint) {
					// CSV with addresses — SQL ran on un-geocoded table
					fails.push({
						ok: false,
						severity: "fail",
						reason: "map could not render — the geometry was lost",
						suggestedFix:
							"geocode the address columns FIRST, then run any SQL/bucketize step on the GEOCODED output (not the original table), and keep all columns (SELECT *) so the geometry survives to render.map",
					});
				}
				// If neither pattern matched it's an unrecognised variant — skip
				if (noGeomNoAddr || hasAddressHint) continue;
			}
			// A summary still containing ${...} means the model wrote a template
			// it expected the system to fill — render.summary shows text
			// literally, so the user would see raw "${x}" placeholders.
			if (r.kind === "summary" && /\$\{/.test(r.text)) {
				fails.push({
					ok: false,
					severity: "fail",
					reason: "the summary contains unfilled ${...} placeholders",
					suggestedFix:
						"render.summary text is literal — compute the values with sql/stats first and write the actual numbers into the text (or use render.table), never ${...} placeholders",
				});
				continue;
			}
			if (r.kind !== "layer") continue;
			const features = (r.geojson?.features ?? []) as GeoJSON.Feature[];
			const nonEmpty = guardLayerNonEmpty(features.length);
			if (!nonEmpty.ok) {
				fails.push(nonEmpty);
				continue;
			}
			const style = r.style as Parameters<typeof guardColorBy>[1] | undefined;
			if (style?.colorBy && features.length >= 20) {
				const cb = guardColorBy(features, style);
				if (!cb.ok) fails.push(cb);
			}
		}
		// Claim-grounding: if a summary contradicts the table the same plan
		// computed (D9-Q3: table Middle=7.4 highest, summary "Elementary is
		// highest"), flag it for the cheap CoVe correction path. Only when no
		// harder guard already fired — a re-plan supersedes a text fix.
		if (fails.length === 0 && lastTable && lastSummary) {
			const grounding = checkClaimGrounding({
				summary: lastSummary,
				rows: lastTable.rows,
				columns: lastTable.columns,
			});
			if (!grounding.ok) {
				return {
					ok: false,
					feedback: "",
					message: `The summary contradicted the computed data: ${grounding.reason}.`,
					groundingFix: {
						table: lastTable,
						badSummary: lastSummary,
						reason: grounding.reason,
					},
				};
			}
		}

		if (fails.length === 0) return { ok: true, feedback: "", message: "" };
		const lines = fails.map(
			(f) => `- ${f.reason}${f.suggestedFix ? ` → ${f.suggestedFix}` : ""}`,
		);
		const feedback =
			`Your previous plan produced a poor result:\n${lines.join("\n")}\n` +
			"Try a DIFFERENT strategy: if grouping or coloring by a free-text " +
			"column, insert a transform.bucketize step to derive clean categories " +
			"first; otherwise pick a cleaner column, relax the filter, or add a region.";
		const fix = fails.find((f) => f.suggestedFix)?.suggestedFix;
		const message =
			`The result still looks off: ${fails.map((f) => f.reason).join("; ")}.` +
			(fix ? ` Suggestion: ${fix}` : "");
		return { ok: false, feedback, message };
	}

	/**
	 * CoVe correction: make ONE forced-tool call to rewrite a summary that
	 * contradicted its own computed table, grounded in the real cells.
	 * Returns the corrected text, or null on any failure (caller falls back
	 * to the honest message). Uses the active provider — works on UF
	 * Navigator / Groq / OpenAI / Anthropic via the shared forced-tool layer.
	 */
	private async _correctGroundedSummary(
		fix: {
			table: {
				columns: ReadonlyArray<string>;
				rows: ReadonlyArray<Record<string, unknown>>;
			};
			badSummary: string;
			reason: string;
		},
		signal: AbortSignal,
	): Promise<string | null> {
		if (!this._apiKey) return null;
		if (!this._llmCall && !this.dangerouslyAllowBrowser) return null;
		return correctSummary(
			{
				call: (input) =>
					callForcedTool({
						provider: this._llmProvider,
						apiKey: this._apiKey as string,
						model: this._model,
						cachedSystemPrompt: input.cachedSystemPrompt,
						userMessage: input.userMessage,
						toolName: input.toolName,
						toolDescription: input.toolDescription,
						toolInputSchema: input.toolInputSchema,
						temperature: 0,
						maxTokens: 512,
						signal,
						dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
					}),
			},
			{ table: fix.table, badSummary: fix.badSummary, reason: fix.reason },
		);
	}

	/**
	 * Build the inspection context for agentic mode. Returns undefined when
	 * the engine isn't available (e.g. tests that haven't installed an
	 * executor stub) — the planner falls back to single-shot in that case.
	 */
	private _buildAgenticCtx():
		| { engine: ExecutorEngine; datasets: Map<string, ExecDatasetEntry> }
		| undefined {
		const engine = this._resolveExecutorEngine();
		if (!engine) return undefined;
		const datasets = new Map<string, ExecDatasetEntry>();
		for (const d of this._execDatasets) datasets.set(d.name, d);
		return { engine, datasets };
	}

	/**
	 * Pick the OpenAI-compat /chat/completions endpoint for the active
	 * provider, or undefined if the active provider doesn't speak the
	 * OpenAI tool-call schema (Anthropic, Gemini today). When undefined,
	 * agentic mode degrades to single-shot at planner construction.
	 */
	private _agenticEndpointForActiveProvider(): string | undefined {
		switch (this._llmProvider) {
			case "groq":
				return "https://api.groq.com/openai/v1/chat/completions";
			case "openai":
				return "https://api.openai.com/v1/chat/completions";
			case "uf-navigator":
				return "https://api.ai.it.ufl.edu/v1/chat/completions";
			// Anthropic uses a native adapter (not an OpenAI-compat endpoint).
			// The sentinel makes agenticActive=true so the native loop runs —
			// but only when the host hasn't injected a custom planner llmCall
			// (tests/headless hosts do). With a custom llmCall we keep the
			// single-shot path so that override is honored deterministically.
			case "anthropic":
				return this._llmCall ? undefined : "anthropic-native";
			// Gemini has a different multi-turn shape; not yet supported.
			default:
				return undefined;
		}
	}

	/** Resolve the engine handle: test override → main-thread DuckDB → null. */
	private _resolveExecutorEngine(): ExecutorEngine | null {
		if (this._executorEngine) return this._executorEngine;
		try {
			return toExecutorEngine(getEngine());
		} catch {
			return null;
		}
	}

	/** Test-only: substitute the executor engine for deterministic tests. */
	__setExecutorEngine(engine: ExecutorEngine): void {
		this._executorEngine = engine;
	}

	/**
	 * HIGH-04 fix: when the executor produces an intermediate layer/table
	 * (e.g. `geocoded` from a `geocode.address` step), profile the view
	 * and add it to `_datasets` so the next planner turn can see it. Without
	 * this, a follow-up like "how many of those geocoded?" would re-run
	 * the upstream operation instead of querying the existing layer.
	 *
	 * Best-effort: never throws back to the executor. Failure to profile
	 * just means the layer won't appear in the next dataset_refs block —
	 * the layer still exists as a DuckDB view and can be referenced by
	 * name if the planner happens to remember it.
	 */
	private async _registerIntermediateLayer(
		ref: string,
		outputVar: string,
	): Promise<void> {
		try {
			const engine = this._resolveExecutorEngine();
			if (!engine) return;
			// Quote the view identifier: replace inner double-quotes by
			// doubling, then wrap. Runner-emitted refs match
			// /^[a-z_][a-z0-9_]*$/ so this is paranoid-safe.
			const quoted = `"${ref.replace(/"/g, '""')}"`;
			const sample = await engine.query(`SELECT * FROM ${quoted} LIMIT 5`);
			// Coerce BigInt → Number so JSON.stringify(sample) never throws
			// when builders.ts serializes the sample into the planner prompt.
			const rowsArr = (sample.toArray() as Array<Record<string, unknown>>).map(
				(r) => {
					const o: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(r))
						o[k] = typeof v === "bigint" ? Number(v) : v;
					return o;
				},
			);
			const cols = rowsArr[0]
				? Object.keys(rowsArr[0]).map((c) => ({
						name: c,
						type: "varchar",
					}))
				: [];
			const countResult = await engine.query(
				`SELECT COUNT(*) AS n FROM ${quoted}`,
			);
			const countRows = countResult.toArray() as Array<{ n: number | bigint }>;
			const rows = Number(countRows[0]?.n ?? 0);
			// Build a minimal PlannerDatasetProfile so the planner sees this
			// layer in dataset_refs on the next turn. The name we register
			// under is the friendly `outputVar` (e.g. "geocoded"), which is
			// the same name the planner referenced in step.output_var on the
			// prior plan — so anaphora resolution lines up.
			const profile: PlannerDatasetProfile = {
				name: outputVar,
				kind: "layer",
				rows,
				columns: cols,
				sample: rowsArr.slice(0, 3),
			};
			this._datasets = [
				...this._datasets.filter((d) => d.name !== outputVar),
				profile,
			];
		} catch {
			// best-effort; failure must not abort the executor's plan
		}
	}

	/** Mount a result payload into <result-canvas> in full mode. */
	private _mountResult(e: ExecResultEvent): void {
		const canvas = this._canvas();
		if (!canvas) return;
		// Pass origin metadata so the canvas's per-panel save buttons have context.
		canvas.setOrigin({
			planId: e.planId,
			stepId: e.stepId,
			question: this._lastQuestion,
		});
		// Strip planId/stepId before handing to the canvas — it only cares about the payload.
		const { planId: _p, stepId: _s, ...payload } = e;
		void _p;
		void _s;
		canvas.setResult(payload as { kind: string; [k: string]: unknown });

		// When a render.map result lands, surface it as a derived layer in the
		// Contents panel. The most recent one keeps its NEW badge until the
		// user runs another execution.
		if (e.kind === "layer") {
			const name = (e as { name?: string }).name ?? "result";
			const features = Array.isArray(e.geojson?.features)
				? e.geojson.features.length
				: 0;
			const id = `layer_${e.planId}_${e.stepId}`;
			this._derivedLayers = [
				{ id, name, features, visible: true, isNew: true },
				...this._derivedLayers
					.filter((l) => l.id !== id)
					.map((l) => ({ ...l, isNew: false })),
			];
		}
	}

	/** Open a new chat turn on the canvas (shows the user's question bubble). */
	private _beginCanvasTurn(question: string): void {
		const canvas = this._canvas();
		canvas?.beginTurn(question);
	}

	/** Find the result-canvas in shadow DOM (declared in the template, so always present in full mode). */
	private _canvas(): {
		setResult(p: { kind: string; [k: string]: unknown }): void;
		setOrigin(o: { planId: string; stepId: string; question: string }): void;
		beginTurn(q: string): void;
		correctLastSummary(text: string): void;
		clear(): void;
	} | null {
		return (
			(this.shadowRoot?.querySelector("result-canvas") as unknown as {
				setResult(p: { kind: string; [k: string]: unknown }): void;
				setOrigin(o: {
					planId: string;
					stepId: string;
					question: string;
				}): void;
				beginTurn(q: string): void;
				correctLastSummary(text: string): void;
				clear(): void;
			} | null) ?? null
		);
	}

	/** Handle save-result event bubbled up from <result-canvas> panel save buttons. */
	private _onSaveResult = (e: Event): void => {
		const detail = (
			e as CustomEvent<{
				kind: string;
				payload: Record<string, unknown>;
				title: string;
				origin: { planId: string; stepId: string; question: string };
			}>
		).detail;
		const saveKind: SavedResultV1["kind"] =
			detail.kind === "layer" ? "map" : (detail.kind as SavedResultV1["kind"]);
		this.saves.add({
			title: detail.title,
			kind: saveKind,
			origin: detail.origin,
			payload: detail.payload,
		});
	};

	private _buildCritic(): {
		diagnose: (
			ctx: StepErrorContext,
			signal?: AbortSignal,
		) => Promise<CriticDecision>;
	} | null {
		if (this._criticOverride) return this._criticOverride;
		if (!this._apiKey) return null;
		return new Critic({
			provider: this._llmProvider,
			apiKey: this._apiKey,
			model: this._model,
			datasets: this._datasets,
			dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
		});
	}

	/** Locate the live <plan-review> in shadow DOM. Typed via the imported class
	 *  so future renames or property changes surface as compile errors instead
	 *  of being silently absorbed by inline `as never` casts. Returns null
	 *  in headless mode (no shadow DOM children) or before the first plan. */
	private _planReview(): PlanReview | null {
		return this.shadowRoot?.querySelector("gcb-modal plan-review") ?? null;
	}

	/**
	 * Stream an agentic-loop step into the result canvas as a "thought"
	 * entry so the user can watch the bot reason in real time. Truncates
	 * long observations so a probe_sql returning a wide row dump doesn't
	 * blow out the UI.
	 */
	private _pushAgenticThought(e: GeoChatBotEvents["agentic-step"]): void {
		if (this.mode === "headless") return;
		const canvas = this.shadowRoot?.querySelector("result-canvas") as
			| (HTMLElement & {
					appendThought(t: {
						kind: string;
						iteration: number;
						text: string;
						observation?: string;
					}): void;
			  })
			| null;
		if (!canvas) return;
		const trunc = (s: string, n = 240): string =>
			s.length > n ? `${s.slice(0, n)}…` : s;
		switch (e.kind) {
			case "reason": {
				const txt = (e.text ?? "").trim();
				if (!txt) return;
				canvas.appendThought({
					kind: "reason",
					iteration: e.iteration,
					text: trunc(txt, 600),
				});
				return;
			}
			case "tool": {
				const argsLine = JSON.stringify(e.args);
				canvas.appendThought({
					kind: "tool",
					iteration: e.iteration,
					text: `${e.toolId}(${trunc(argsLine, 120)})`,
					observation: trunc(e.observation, 480),
				});
				return;
			}
			case "finalize":
				canvas.appendThought({
					kind: "finalize",
					iteration: e.iteration,
					text: `Plan ready · ${e.plan.steps.length} step${e.plan.steps.length === 1 ? "" : "s"}: ${e.plan.steps.map((s) => s.tool).join(" → ")}`,
				});
				return;
			case "unknown-tool":
				canvas.appendThought({
					kind: "unknown-tool",
					iteration: e.iteration,
					text: `Model called unknown tool: ${e.toolId}`,
				});
				return;
			case "budget-exhausted":
				canvas.appendThought({
					kind: "budget-exhausted",
					iteration: e.iteration,
					text: "Iteration budget exhausted before finalize_plan",
				});
				return;
			case "rate-limit-wait": {
				// AUDIT-K4 (2026-05-11): surface a clear countdown line so
				// the user knows the bot is parked on a 429, not hung.
				const secs = Math.ceil(e.waitMs / 1000);
				canvas.appendThought({
					kind: "rate-limit-wait",
					iteration: e.iteration,
					text: `Rate limit hit — waiting ${secs}s before retry ${e.attempt} (provider Retry-After respected)`,
				});
				return;
			}
			case "clarify-needed": {
				// The model needs information only the user can provide (e.g. what
				// city are these addresses in?). Surface the question as a special
				// thought so the user sees it before they type in the input box.
				canvas.appendThought({
					kind: "clarify-needed",
					iteration: e.iteration,
					text: `❓ ${e.question}`,
				});
				return;
			}
		}
	}

	private _pushPlanStatus(e: ExecProgressEvent): void {
		const pr = this._planReview();
		if (!pr) return;
		if (pr.mode !== "running") pr.mode = "running";
		if (e.stepId) {
			const next = new Map(pr.stepStatus);
			// ProgressEvent.status is 'running' | 'success' | 'fail'; <plan-review>
			// treats StepStatus as a wider type that also includes 'pending' | 'retry'.
			// The narrower-into-wider assignment is sound; cast to the wider Map
			// so the assignment compiles without `any`.
			next.set(e.stepId, e.status);
			pr.stepStatus = next as Map<
				string,
				import("./ui/plan-review.js").StepStatus
			>;
			if (e.durationMs !== undefined) {
				const d = new Map(pr.stepDurations);
				d.set(e.stepId, Math.round(e.durationMs));
				pr.stepDurations = d;
			}
			pr.requestUpdate();
		}
	}

	private _pushCriticAttempt(
		detail: GeoChatBotEvents["critic"],
		decision: CriticDecision,
	): void {
		const pr = this._planReview();
		if (!pr) return;
		const ss = new Map(pr.stepStatus);
		ss.set(detail.stepId, "retry");
		pr.stepStatus = ss;
		const log = new Map(pr.criticAttempts);
		const arr = log.get(detail.stepId) ?? [];
		log.set(detail.stepId, [
			...arr,
			{
				attempt: detail.attempt,
				maxAttempts: detail.maxAttempts,
				decision: detail.decision,
				errorMessage: detail.errorMessage,
			},
		]);
		pr.criticAttempts = log;
		if (decision.action === "patch") {
			const patches = new Map(pr.criticPatches);
			patches.set(detail.stepId, decision.patchedStep);
			pr.criticPatches = patches;
		}
		pr.requestUpdate();
	}

	private _renderPlanIfFull(): void {
		// Read the property, not the attribute. `setMode('headless')` writes
		// `this.mode` synchronously; the attribute only mirrors back via
		// Lit's `reflect` _after_ the next update, so calling this method
		// before the element has rendered (or before connection in tests)
		// would otherwise miss the headless guard and append a plan-review
		// into a widget that is supposed to be event-only.
		if (this.mode === "headless") return;
		if (!this._pendingPlan) return;
		const planId = this._pendingPlan.id;

		// Tear down any previous modal+plan-review so listeners don't carry
		// stale closures into a new plan id.
		const oldModal = this.shadowRoot?.querySelector("gcb-modal");
		if (oldModal) oldModal.remove();

		interface PlanReviewEl extends HTMLElement {
			plan?: Plan;
			mode?: "plan" | "running";
		}
		const modal = document.createElement("gcb-modal") as HTMLElement & {
			open: boolean;
		};
		modal.open = true;
		modal.addEventListener("gcb:modal-close", () => {
			this._cancelPendingPlanByDismiss(planId);
			modal.open = false;
		});

		const pr = document.createElement("plan-review") as PlanReviewEl;
		// Order intentional: approvePlan/rejectPlan kick off their async work
		// synchronously (delete _pendingPlan, fire-and-forget _execute or
		// planner.plan), but neither removes the modal — so `modal.open = false`
		// on the next line still runs against a live node and dismisses the UI.
		pr.addEventListener("plan:approve", () => {
			this.approvePlan(planId);
			modal.open = false;
		});
		pr.addEventListener("plan:reject", () => {
			this.rejectPlan({ id: planId });
			modal.open = false;
		});
		pr.addEventListener("step:edit", (ev: Event) => {
			const detail = (
				ev as CustomEvent<{ stepId: string; args: Record<string, unknown> }>
			).detail;
			this._handleStepEdit(planId, detail, pr);
		});

		modal.appendChild(pr);
		this.shadowRoot?.appendChild(modal);

		pr.plan = this._pendingPlan.plan;
		pr.mode = "plan";
	}

	/**
	 * Apply a step edit from `<plan-review>`. Re-runs the full Plan validator
	 * against the proposed mutation; on failure the edit is rejected and an
	 * `error` event is dispatched. On success the pending plan is replaced
	 * with a freshly-cloned Plan so Lit re-renders cleanly and the original
	 * (validated) Plan is not mutated in place.
	 */
	private _handleStepEdit(
		planId: string,
		detail: { stepId: string; args: Record<string, unknown> },
		pr: HTMLElement & { plan?: Plan },
	): void {
		if (!this._pendingPlan || this._pendingPlan.id !== planId) return;
		const current = this._pendingPlan.plan;
		const idx = current.steps.findIndex((s) => s.id === detail.stepId);
		if (idx === -1) return;
		const candidate: Plan = {
			...current,
			steps: current.steps.map((s, i) =>
				i === idx ? { ...s, args: detail.args } : s,
			),
		};
		const datasetNames = this._datasets.map((d) => d.name);
		try {
			const revalidated = validatePlan(candidate, datasetNames);
			this._pendingPlan = { id: planId, plan: revalidated };
			pr.plan = revalidated;
		} catch (err) {
			const code =
				err instanceof PlanValidationError ? "EDIT_INVALID" : errCode(err);
			this.dispatch("error", {
				planId,
				stepId: detail.stepId,
				code,
				message: errMessage(err, "edit failed validation"),
			});
		}
	}

	/**
	 * Export a loaded dataset as GeoJSON, suitable for pushing into a host
	 * map. Phase 2 stub: returns a `FeatureCollection` skeleton with no
	 * features, plus a `meta.warning` field. Phase 5 will populate features
	 * from the Arrow table via DuckDB-WASM.
	 *
	 * Returns `undefined` for unknown table names so callers can branch
	 * without try/catch.
	 */
	exportLayer(name: string):
		| {
				type: "FeatureCollection";
				features: ReadonlyArray<unknown>;
				meta: { name: string; warning?: string };
		  }
		| undefined {
		const result = this.loaded.find((r) => r.name === name);
		if (!result) return undefined;
		return {
			type: "FeatureCollection",
			features: [],
			meta: {
				name,
				warning:
					"Phase 2 stub: features are not yet materialized. Wired up in Phase 5.",
			},
		};
	}

	/**
	 * Subscribe to a typed event. Returns an unsubscribe function.
	 *
	 * Sugar over `addEventListener` that unwraps the `CustomEvent.detail`.
	 */
	on<K extends keyof GeoChatBotEvents>(
		event: K,
		handler: (detail: GeoChatBotEvents[K]) => void,
	): () => void {
		const name = EVENT_NAME[event];
		const listener = (e: Event) => {
			const ce = e as CustomEvent<GeoChatBotEvents[K]>;
			handler(ce.detail);
		};
		this.addEventListener(name, listener as EventListener);
		return () => this.removeEventListener(name, listener as EventListener);
	}

	/**
	 * Reset loaded datasets, profiles, errors, and drag state. Also wipes
	 * planner state (pending plans, planner-side dataset profiles, cached
	 * Planner instance, and the active API key) so a `clear()` between
	 * users / tenants does not leak prior session state into the next
	 * `setProvider()` + `ask()` round-trip. The operating mode and the
	 * `dangerouslyAllowBrowser` opt-in are preserved.
	 */
	clear(): void {
		this.generation++;
		this.planCounter = 0;
		this.loaded = [];
		this.profiles = {};
		this.error = null;
		this.busy = false;
		this._execDatasets = [];
		// Phase 4 / 5 / 6 state — must be wiped to avoid cross-session leaks.
		this._datasets = [];
		this._pendingPlan = undefined;
		this._pendingClarification = undefined;
		this._planner = undefined;
		this._apiKey = undefined;
		this._criticOverride = undefined;
		// Cancel any in-flight critic LLM round-trip. The Critic.diagnose
		// catch path re-throws AbortError, the executor maps it to abort,
		// and the host's onError surfaces the original step error — so a
		// clear() during a retry tears down cleanly without leaking tokens
		// or a dangling fetch.
		this._execAbort?.abort();
		this._execAbort = undefined;
		// Cancel any in-flight planner/replan LLM round-trip. Without this
		// the gen-guard suppresses the resolved plan but the network call
		// keeps running to completion (token waste; key still in flight).
		this._planAbort?.abort();
		this._planAbort = undefined;
		this.provider = undefined;
		// UI state: drop the masked key chip, close any open drawer, reset
		// busy. The localStorage values are NOT removed — clear() is a
		// session reset, not a "forget my key" affordance. Users opt out
		// of persistence by reopening Settings and saving an empty key.
		this._settingsOpen = false;
		this._agentBusy = false;
		this._maskedKey = null;
		this._activeSaveId = null;
		// AUDIT-022: wipe per-session state the rail / canvas may still
		// reference after `clear()`. Without these resets a click on an
		// old saved-layer row (rail) would re-mount a card whose
		// `_origin` carries the pre-clear planId/stepId — confusing the
		// canvas's turn bookkeeping and the saves-store correlation.
		this._lastQuestion = "";
		this._derivedLayers = [];
		if (this.shadowRoot) {
			const canvas = this.shadowRoot.querySelector("result-canvas") as
				| (HTMLElement & { clear(): void })
				| null;
			canvas?.clear();
			const modal = this.shadowRoot.querySelector("gcb-modal");
			modal?.remove();
		}
	}

	/**
	 * Standard custom-element teardown hook. Removing `<geo-chatbot>` from
	 * the DOM (SPA navigation, dashboard panel hide, HMR) must abort any
	 * in-flight planner/critic LLM call and bump the generation token so
	 * a late-resolving promise cannot fire events on the detached element
	 * or mount a stale plan-review. We deliberately do NOT dispose the
	 * shared DuckDB engine singleton here — other widget instances on the
	 * same page still rely on it. Provider / apiKey survive so that
	 * re-attaching the element resumes correctly.
	 */
	private _unsubscribeTheme: (() => void) | undefined;

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.generation++;
		this._execAbort?.abort();
		this._execAbort = undefined;
		this._planAbort?.abort();
		this._planAbort = undefined;
		this._pendingPlan = undefined;
		this._unsubscribeTheme?.();
		this._unsubscribeTheme = undefined;
		if (this._savesChange) {
			this.saves.removeEventListener("change", this._savesChange);
			this._savesChange = undefined;
		}
	}

	/**
	 * Internal: dispatch a typed CustomEvent on both the namespaced
	 * (`geochatbot:<key>`) and unprefixed (`<key>`) names. The typed `on()`
	 * helper subscribes to the namespaced form; raw `addEventListener` calls
	 * commonly target the unprefixed form, so we cover both.
	 */
	private dispatch<K extends keyof GeoChatBotEvents>(
		event: K,
		detail: GeoChatBotEvents[K],
	): void {
		const init: CustomEventInit<GeoChatBotEvents[K]> = {
			detail,
			bubbles: true,
			composed: true,
		};
		this.dispatchEvent(
			new CustomEvent<GeoChatBotEvents[K]>(EVENT_NAME[event], init),
		);
		this.dispatchEvent(new CustomEvent<GeoChatBotEvents[K]>(event, init));
	}

	/** Public read-only view of the currently loaded results (for tests). */
	get results(): readonly LoadResult[] {
		return this.loaded;
	}

	/* -------------------------------------------------------------------- */
	/* Rendering helpers                                                    */
	/* -------------------------------------------------------------------- */

	private renderTable(result: LoadResult) {
		const profile = this.profiles[result.name];
		// Build a Set of geometry-bearing column names so the lonlat case
		// (which has TWO columns) highlights both correctly. The previous
		// implementation joined them with a comma, which never matched.
		const geomCols = new Set<string>();
		if (result.geometry) {
			if (result.geometry.kind === "lonlat") {
				geomCols.add(result.geometry.lonColumn);
				geomCols.add(result.geometry.latColumn);
			} else {
				geomCols.add(result.geometry.column);
			}
		}
		const cols = profile
			? profile.columns
			: result.table.schema.fields.map((f) => ({
					name: f.name,
					kind: "other" as const,
					arrowType: String(f.type),
					nullCount: 0,
				}));
		const summary = profile
			? `${result.source} · ${profile.rowCount.toLocaleString()} rows · ${profile.columns.length} columns${
					profile.geometry
						? ` · geometry: ${profile.geometry.column} (${profile.geometry.encoding}, ${profile.geometry.crsGuess})`
						: ""
				}`
			: `${result.source} · ${result.table.numRows.toLocaleString()} rows · ${result.table.schema.fields.length} columns`;
		return html`
      <div class="table-card">
        <h3>${result.name}</h3>
        <div class="summary">${summary}</div>
        <table>
          <thead>
            <tr><th>column</th><th>kind</th><th>arrow type</th><th>nulls</th></tr>
          </thead>
          <tbody>
            ${cols.map(
							(c) => html`<tr>
                <td class=${geomCols.has(c.name) ? "geom" : ""}>${c.name}</td>
                <td>${"kind" in c ? c.kind : ""}</td>
                <td>${c.arrowType}</td>
                <td>${c.nullCount ?? ""}</td>
              </tr>`,
						)}
          </tbody>
        </table>
      </div>
    `;
	}

	private geometryLayers() {
		return this.loaded.flatMap((r) =>
			r.geometry
				? [{ name: r.name, table: r.table, geometry: r.geometry }]
				: [],
		);
	}

	/* -------------------------------------------------------------------- */
	/* Drag & drop / picker                                                 */
	/* -------------------------------------------------------------------- */

	private openPicker = () => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = ".csv,.tsv,.geojson,.json,.zip,.shp,.xlsx,.xls,.parquet";
		input.addEventListener("change", async () => {
			if (input.files) await this.handleFiles(Array.from(input.files));
		});
		input.click();
	};

	private _onFilesFromPopover = async (e: Event): Promise<void> => {
		const files = (e as CustomEvent<File[]>).detail;
		this._uploadOpen = false;
		await this.handleFiles(files);
	};

	private async handleFiles(files: File[]) {
		for (const f of files) {
			await this.pushData(f);
		}
	}

	/* -------------------------------------------------------------------- */
	/* Single ingest path                                                   */
	/* -------------------------------------------------------------------- */

	private async ingest(input: BinaryInput): Promise<void> {
		const gen = this.generation;
		this.busy = true;
		this.error = null;
		try {
			const result = await loadFile(input);
			if (gen !== this.generation) return; // clear() ran while loading — drop result
			const profile = profileDataset(result);
			this.profiles = { ...this.profiles, [result.name]: profile };

			// Best-effort engine registration. wasm boot may fail without
			// COOP/COEP headers; we still show the schema + map.
			let engineRegistered = false;
			try {
				const engine = getEngine();
				await engine.init();
				const reg = await engine.registerArrow(result);
				engineRegistered = true;
				// Phase 5: record the executor-facing entry so the agent loop
				// can resolve `${dataset}` references to DuckDB views.
				this._execDatasets = [
					...this._execDatasets.filter((d) => d.name !== result.name),
					{
						name: result.name,
						tableName: reg.tableName,
						...(reg.geomView ? { geomView: reg.geomView } : {}),
						hasGeometry: !!reg.geomView,
					},
				];
			} catch (err) {
				// Same redaction as the inline-rows path above: log code only,
				// never the raw err — keeps any request URL / auth header out
				// of the DevTools console and any console-intercepting telemetry.
				console.warn(
					"[geochatbot] engine registration failed; continuing in JS-only mode",
					errCode(err),
				);
			}

			if (gen !== this.generation) return; // clear() ran during engine init

			// Lazy-load the MapView module the first time we see geometry. This
			// keeps MapLibre GL + deck.gl out of the initial bundle (PLAN §3).
			if (result.geometry && !this._mapModuleLoaded) {
				await import("./ui/MapView.js");
				if (gen !== this.generation) return;
				this._mapModuleLoaded = true;
			}

			this.loaded = [...this.loaded, result];

			// Phase 4 sync: every ingested file must also become a planner-side
			// DatasetProfile so the Planner can reference it by name from a user
			// question. Without this, ask() after a drop produces an empty
			// dataset_refs check failure. The mapping is intentionally lossy —
			// sample rows are not extracted here (kept empty) to avoid
			// round-tripping potentially sensitive content through the agent
			// unless the host explicitly opts in via pushData(profile).
			this._datasets = [
				...this._datasets.filter((d) => d.name !== result.name),
				toPlannerDatasetProfile(result.name, profile),
			];

			this.dispatch("dataset-loaded", {
				name: result.name,
				source: result.source,
				profile,
				engineRegistered,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code =
				err && typeof err === "object" && "code" in err
					? String((err as { code: unknown }).code)
					: undefined;
			this.error = message;
			// Important: never include `cause: err` — provider/network errors can
			// carry the request URL / Authorization header in their message, and
			// dispatching the raw Error object would surface that to any DOM
			// listener (including dev-tool hooks). Stick to {message, code?}.
			const errorDetail: GeoChatBotEvents["error"] = code
				? { message, code }
				: { message };
			this.dispatch("error", errorDetail);
		} finally {
			// Only release the busy lock if we still own the current generation.
			// If clear() ran while we were loading, a re-drop may already be
			// in flight and we mustn't stomp its busy state.
			if (gen === this.generation) this.busy = false;
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"geo-chatbot": GeoChatBotElement;
	}
}
