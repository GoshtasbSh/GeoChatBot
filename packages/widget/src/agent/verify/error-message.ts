import { classifyFailure } from "./failure-classifier.js";

/**
 * Turn a raw executor error into an honest, actionable message. Infra
 * failures (network/proxy/CORS/5xx) are reframed as environment issues —
 * NOT the user's data — with a concrete fix when we can name one. Logic
 * errors pass through unchanged (they already describe a fixable cause).
 */
export function friendlyExecError(message: string): string {
	const cls = classifyFailure({ kind: "error", message });
	if (cls.cls === "infra") {
		if (/census|geocod/i.test(message))
			return `Couldn't reach the geocoding service — this is an environment/proxy issue, not your data. Fix: restart the dev server so the /api/census-geocode proxy is active (or configure that proxy in production). [${message}]`;
		return `Couldn't reach an external service — this looks like a network/connection issue, not your data. [${message}]`;
	}
	return message;
}
