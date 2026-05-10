/**
 * SavesStore — localStorage-backed CRUD for pinned agent results.
 *
 * Schema is versioned (`version: 1`); on read we drop any entry whose
 * version doesn't match, so a future schema change is safe.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §4
 */
export type SavedResultKind = "chart" | "table" | "map" | "summary";

export interface SavedResultV1 {
	id: string;
	version: 1;
	createdAt: number;
	title: string;
	origin: { planId: string; stepId: string; question: string };
	kind: SavedResultKind;
	payload: Record<string, unknown>;
}

const STORAGE_KEY = "geochatbot:saves:v1";
const MAX_ENTRIES = 200;

function makeId(): string {
	return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeReadAll(): SavedResultV1[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		return (arr as unknown[]).filter((x): x is SavedResultV1 => {
			if (!x || typeof x !== "object") return false;
			const o = x as { version?: unknown; id?: unknown };
			return o.version === 1 && typeof o.id === "string";
		});
	} catch {
		return [];
	}
}

function safeWriteAll(list: SavedResultV1[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		// localStorage may be unavailable (private mode, hardened CSP, quota).
		// The in-memory list still works; we silently no-op the persist.
	}
}

export class SavesStore extends EventTarget {
	list(): SavedResultV1[] {
		return safeReadAll();
	}

	get(id: string): SavedResultV1 | undefined {
		return safeReadAll().find((x) => x.id === id);
	}

	add(
		input: Omit<SavedResultV1, "id" | "version" | "createdAt">,
	): SavedResultV1 {
		const now = Date.now();
		const entry: SavedResultV1 = {
			id: makeId(),
			version: 1,
			createdAt: now,
			...input,
		};
		let next = [...safeReadAll(), entry];
		if (next.length > MAX_ENTRIES) {
			next = next.slice(next.length - MAX_ENTRIES);
		}
		safeWriteAll(next);
		this._emit();
		return entry;
	}

	rename(id: string, title: string): void {
		const list = safeReadAll();
		const next = list.map((x) => (x.id === id ? { ...x, title } : x));
		safeWriteAll(next);
		this._emit();
	}

	remove(id: string): void {
		const list = safeReadAll();
		const next = list.filter((x) => x.id !== id);
		safeWriteAll(next);
		this._emit();
	}

	clear(): void {
		safeWriteAll([]);
		this._emit();
	}

	private _emit(): void {
		this.dispatchEvent(new Event("change"));
	}
}
