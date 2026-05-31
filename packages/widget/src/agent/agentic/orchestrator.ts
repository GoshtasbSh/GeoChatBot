import type { DatasetProfile } from "../prompts/builders.js";
import type { Classification } from "../verify/failure-classifier.js";
import type { GuardResult } from "../verify/outcome-guards.js";

export interface Verdict {
	ok: boolean;
	guards: GuardResult[];
}
export interface ExecOutcome {
	ok: boolean;
	outputs: unknown[];
	error?: { message: string };
}

export interface OrchestratorInput {
	query: string;
	profile: DatasetProfile;
}
export interface OrchestratorDeps {
	plan(
		query: string,
		profile: DatasetProfile,
		recovery?: string,
	): Promise<{ id: string; steps: unknown[] }>;
	execute(plan: { id: string; steps: unknown[] }): Promise<ExecOutcome>;
	verify(
		plan: { id: string; steps: unknown[] },
		outcome: ExecOutcome,
	): Promise<Verdict>;
	classify(v: Verdict, outcome: ExecOutcome): Classification;
	maxAttempts: number;
}

export type ReliableResult =
	| { status: "success"; outputs: unknown[] }
	| { status: "infra_failure"; reason: string }
	| { status: "logic_failure"; reason: string };

function recoveryContext(v: Verdict): string {
	const fails = v.guards.filter((g) => !g.ok);
	return [
		"Your previous attempt produced a poor result:",
		...fails.map(
			(g) => `- ${g.reason}${g.suggestedFix ? ` → ${g.suggestedFix}` : ""}`,
		),
		"Try a DIFFERENT strategy (different columns, bucketize first, different region/runner). Do not repeat the same plan.",
	].join("\n");
}

export async function runReliable(
	input: OrchestratorInput,
	deps: OrchestratorDeps,
): Promise<ReliableResult> {
	let recovery: string | undefined;
	let last: Verdict | undefined;
	for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
		const plan = await deps.plan(input.query, input.profile, recovery);
		const outcome = await deps.execute(plan);
		const verdict = outcome.ok
			? await deps.verify(plan, outcome)
			: {
					ok: false,
					guards: [
						{
							ok: false,
							severity: "fail" as const,
							reason: outcome.error?.message ?? "execution error",
						},
					],
				};
		if (verdict.ok) return { status: "success", outputs: outcome.outputs };
		last = verdict;
		const cls = deps.classify(verdict, outcome);
		if (cls.cls === "infra")
			return { status: "infra_failure", reason: cls.reason };
		recovery = recoveryContext(verdict);
	}
	return {
		status: "logic_failure",
		reason:
			last?.guards.find((g) => !g.ok)?.reason ??
			"could not produce a good result",
	};
}
