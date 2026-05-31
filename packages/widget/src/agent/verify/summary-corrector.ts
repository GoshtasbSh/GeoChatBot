/**
 * CoVe (Chain-of-Verification) summary corrector.
 *
 * When the deterministic grounding gate (claim-grounding.ts) catches a
 * summary that contradicts the table the plan just computed, we make ONE
 * forced-tool LLM call that rewrites the summary to match the data —
 * cheaper and more surgical than re-running the whole plan, and it keeps
 * the (correct) table/map the user already has.
 *
 * The prompt builder is pure (testable without a network); the LLM call is
 * injected so callers wire in callForcedTool with the active provider/key.
 */

export interface CorrectionTable {
	columns: ReadonlyArray<string>;
	rows: ReadonlyArray<Record<string, unknown>>;
}

export interface CorrectionInput {
	table: CorrectionTable;
	badSummary: string;
	reason: string;
}

const SYSTEM =
	"You correct data summaries. You are given a COMPUTED TABLE (the ground " +
	"truth) and a DRAFT SUMMARY that contradicts it. Rewrite the summary so " +
	"every claim is read EXACTLY from the table — only state facts that are " +
	"directly supported by the table cells. Do not add outside knowledge, do " +
	"not hedge, do not mention that a correction was made. Keep it concise.";

/** Render the table as compact text the model can read cell-by-cell. */
function renderTable(t: CorrectionTable): string {
	const header = t.columns.join(" | ");
	const body = t.rows
		.slice(0, 50)
		.map((r) => t.columns.map((c) => String(r[c] ?? "")).join(" | "))
		.join("\n");
	return `${header}\n${body}`;
}

export function buildCorrectionPrompt(input: CorrectionInput): {
	system: string;
	user: string;
} {
	const user =
		`COMPUTED TABLE (ground truth):\n${renderTable(input.table)}\n\n` +
		`DRAFT SUMMARY (contradicts the table):\n"${input.badSummary}"\n\n` +
		`PROBLEM: ${input.reason}\n\n` +
		"Rewrite the summary so it matches the table exactly. Use the real " +
		"winning row and the real numbers from the table.";
	return { system: SYSTEM, user };
}

/** The forced-tool schema that constrains the model to a single string. */
export const CORRECTED_SUMMARY_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		corrected_summary: {
			type: "string",
			description:
				"The rewritten summary, grounded entirely in the computed table.",
		},
	},
	required: ["corrected_summary"],
	additionalProperties: false,
};

export function parseCorrectedSummary(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const v = (result as { corrected_summary?: unknown }).corrected_summary;
	if (typeof v !== "string") return null;
	const trimmed = v.trim();
	return trimmed === "" ? null : trimmed;
}

/** What the corrector needs from the host: a forced-tool call function. */
export interface CorrectorDeps {
	call: (input: {
		cachedSystemPrompt: string;
		userMessage: string;
		toolName: string;
		toolDescription: string;
		toolInputSchema: Record<string, unknown>;
	}) => Promise<Record<string, unknown>>;
}

/**
 * Make the single corrective call. Returns the corrected summary text, or
 * null if the call fails / returns garbage (caller should fall back to the
 * existing re-plan recovery so a wrong summary is never shipped).
 */
export async function correctSummary(
	deps: CorrectorDeps,
	input: CorrectionInput,
): Promise<string | null> {
	const { system, user } = buildCorrectionPrompt(input);
	try {
		const raw = await deps.call({
			cachedSystemPrompt: system,
			userMessage: user,
			toolName: "emit_corrected_summary",
			toolDescription:
				"Return the corrected summary, grounded entirely in the computed table.",
			toolInputSchema: CORRECTED_SUMMARY_SCHEMA,
		});
		return parseCorrectedSummary(raw);
	} catch {
		return null;
	}
}
