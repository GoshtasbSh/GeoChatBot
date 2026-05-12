/**
 * AUDIT-007: prompt / docs / registry consistency.
 *
 * The agentic-preamble's tool table and `docs/CAPABILITIES.md`'s capability
 * rows tell the user (and the LLM) what's available. If either references
 * a tool that isn't in the registry, the planner will either fail
 * plan-validation at runtime or fabricate a usage that the executor can't
 * fulfill — both produce a worse experience than just doing it via `sql`.
 *
 * This test reads the actual registry, then scans the preamble + docs for
 * any `tool.id`-shaped tokens. Every token that names a tool-group root
 * (geometry, stats, joins, geocode, render, report) MUST either be in
 * the registry OR appear in an explicit "NOT directly registered" block
 * (which we whitelist via a marker).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTIC_PREAMBLE } from "../../src/agent/prompts/agentic-preamble.js";
import "../../src/agent/tools/index.js";
import { listTools } from "../../src/agent/tools/registry.js";

const TOOL_TOKEN_RE =
	/\b(geometry|stats|joins|geocode|render|report)\.[a-z_]+\b/g;

function findMentions(text: string): string[] {
	const set = new Set<string>();
	const matches = text.match(TOOL_TOKEN_RE) ?? [];
	for (const m of matches) set.add(m);
	return [...set];
}

describe("AUDIT-007 — preamble + docs reference only registered tools", () => {
	const registered = new Set(listTools().map((t) => t.id));

	it("agentic-preamble mentions only registered tools", () => {
		const mentions = findMentions(AGENTIC_PREAMBLE);
		// Identify "NOT directly registered" blocks — the preamble explicitly
		// teaches the model that some operations have no dedicated tool and
		// must go through `sql`. Names in those blocks aren't required to be
		// in the registry; they're documentation of the workaround.
		const escapeHatchSections = [
			/NOT directly registered \(use sql with ST_\*\):[\s\S]*?##/,
			/Attribute-only join \(no spatial predicate\) → use sql:[\s\S]*?##/,
			/NOT directly registered \(use sql\):[\s\S]*?#/,
		];
		const escapeHatchTokens = new Set<string>();
		for (const re of escapeHatchSections) {
			const m = AGENTIC_PREAMBLE.match(re);
			if (!m) continue;
			for (const tok of m[0].match(TOOL_TOKEN_RE) ?? []) {
				escapeHatchTokens.add(tok);
			}
		}
		const phantom = mentions.filter(
			(m) => !registered.has(m) && !escapeHatchTokens.has(m),
		);
		expect(phantom).toEqual([]);
	});

	it("docs/CAPABILITIES.md mentions only registered tools (outside ST_* fallbacks)", () => {
		const md = readFileSync(
			resolve(__dirname, "../../../..", "docs", "CAPABILITIES.md"),
			"utf-8",
		);
		const mentions = findMentions(md);
		// CAPABILITIES.md may legitimately reference future / out-of-scope
		// tools inside "What the bot will NOT do" — but currently doesn't.
		// The only legit phantoms are anything inside a code block that
		// shows an ST_*-style sql template; our regex only captures the
		// `group.tool` shape, so ST_Area / ST_Length etc. don't match.
		const phantom = mentions.filter((m) => !registered.has(m));
		expect(phantom).toEqual([]);
	});
});
