// packages/widget/src/agent/verify/failure-classifier.ts
export type FailureClass = "infra" | "logic";

export type FailureInput =
	| { kind: "error"; message: string }
	| {
			kind: "guard";
			guardId: string;
			reason: string;
			inputsLookValid?: boolean;
	  };

export interface Classification {
	cls: FailureClass;
	reason: string;
}

const INFRA_RE =
	/failed to fetch|networkerror|load failed|err_|cors|unexpected token <|in json at position|http 5\d\d|service unavailable|timeout|aborted by the network/i;

export function classifyFailure(f: FailureInput): Classification {
	if (f.kind === "error") {
		if (INFRA_RE.test(f.message))
			return { cls: "infra", reason: "network/proxy/transport error" };
		return { cls: "logic", reason: "validation or runtime logic error" };
	}
	if (f.guardId === "geocode" && f.inputsLookValid)
		return {
			cls: "infra",
			reason:
				"geocode produced 0 with valid-looking inputs — likely a service/proxy outage",
		};
	return { cls: "logic", reason: `guard "${f.guardId}" failed: ${f.reason}` };
}
