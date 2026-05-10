import * as duckdb from "@duckdb/duckdb-wasm";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { Table as ArrowTable } from "apache-arrow";

import type { GeometryEncoding, LoadResult } from "../contracts.js";

/**
 * Sanitize a user-supplied string into a SQL identifier.
 *   - non [A-Za-z0-9_] => '_'
 *   - leading digit    => prefix 't_'
 *   - empty            => fallback random id
 */
export function safeIdent(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
	if (!cleaned) return `t_${Math.random().toString(36).slice(2, 8)}`;
	return /^[0-9]/.test(cleaned) ? `t_${cleaned}` : cleaned;
}

/** Quote an identifier for inclusion in raw SQL. */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

interface RegisteredTable {
	name: string;
	geomView: string | undefined;
}

/**
 * Thin async wrapper around `@duckdb/duckdb-wasm` that:
 *   - boots the WASM bundle (browser via JsDelivr, idempotent),
 *   - loads the spatial extension on a single shared connection,
 *   - registers Arrow tables as DuckDB tables/views,
 *   - exposes a typed `query(sql)` that returns an `apache-arrow` Table,
 *   - tears down DB + worker on dispose.
 *
 * Designed to be process-wide singleton-friendly via `getEngine()`.
 */
export class DuckDBEngine {
	private db: AsyncDuckDB | undefined;
	private conn: AsyncDuckDBConnection | undefined;
	private worker: Worker | undefined;
	private workerObjectUrl: string | undefined;
	private initPromise: Promise<void> | undefined;
	private spatialLoaded = false;
	private readonly tables = new Map<string, RegisteredTable>();

	/** Idempotent. Loads spatial extension. Safe to call concurrently. */
	async init(): Promise<void> {
		if (this.conn) return;
		if (!this.initPromise) {
			this.initPromise = this.bootstrap().catch((err) => {
				// Reset so callers can retry after a transient failure.
				this.initPromise = undefined;
				throw err;
			});
		}
		return this.initPromise;
	}

	private async bootstrap(): Promise<void> {
		if (typeof Worker === "undefined") {
			throw new Error(
				"DuckDBEngine: no Worker global available. duckdb-wasm requires a browser " +
					"or a Worker-capable environment.",
			);
		}

		const bundles = duckdb.getJsDelivrBundles();
		const bundle = await duckdb.selectBundle(bundles);
		if (!bundle.mainWorker) {
			throw new Error(
				"DuckDBEngine: no compatible duckdb-wasm worker bundle for this runtime.",
			);
		}

		const workerObjectUrl = URL.createObjectURL(
			new Blob([`importScripts("${bundle.mainWorker}");`], {
				type: "application/javascript",
			}),
		);
		const worker = new Worker(workerObjectUrl);
		const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
		const db = new duckdb.AsyncDuckDB(logger, worker);
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker ?? undefined);

		const conn = await db.connect();

		// Spatial extension: best-effort. Network failures should not break SQL.
		try {
			await conn.query("INSTALL spatial");
			await conn.query("LOAD spatial");
			this.spatialLoaded = true;
		} catch (err) {
			this.spatialLoaded = false;
			// eslint-disable-next-line no-console
			console.warn("[geochatbot] spatial extension unavailable:", err);
		}

		this.db = db;
		this.conn = conn;
		this.worker = worker;
		this.workerObjectUrl = workerObjectUrl;
	}

	/** True if `LOAD spatial` succeeded during init. */
	get hasSpatial(): boolean {
		return this.spatialLoaded;
	}

	/**
	 * Register an Arrow table as a DuckDB table. If geometry metadata is given,
	 * also expose a derived view "<name>_geom" with a GEOMETRY column `geom`.
	 */
	async registerArrow(
		result: LoadResult,
	): Promise<{ tableName: string; geomView?: string }> {
		await this.init();
		if (!this.conn) throw new Error("DuckDBEngine: not initialized");

		const tableName = safeIdent(result.name);

		// Drop any prior registration with the same logical name so re-uploads
		// overwrite cleanly.
		if (this.tables.has(tableName)) {
			await this.drop(tableName);
		}

		await this.conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
		await this.conn.insertArrowTable(result.table, {
			name: tableName,
			create: true,
		});

		let geomView: string | undefined;
		if (result.geometry) {
			const expr = this.geomExpression(result.geometry);
			if (expr) {
				geomView = `${tableName}_geom`;
				await this.conn.query(`DROP VIEW IF EXISTS ${quoteIdent(geomView)}`);
				await this.conn.query(
					`CREATE VIEW ${quoteIdent(geomView)} AS SELECT *, ${expr} AS geom FROM ${quoteIdent(
						tableName,
					)}`,
				);
			}
		}

		this.tables.set(tableName, { name: tableName, geomView });
		return geomView ? { tableName, geomView } : { tableName };
	}

	/** Build the `geom` SQL expression for a geometry encoding, or undefined if unsupported. */
	private geomExpression(geom: GeometryEncoding): string | undefined {
		if (!this.spatialLoaded) {
			// eslint-disable-next-line no-console
			console.warn(
				"[geochatbot] spatial extension not loaded; skipping geometry view creation.",
			);
			return undefined;
		}
		switch (geom.kind) {
			case "lonlat":
				return `ST_Point(CAST(${quoteIdent(geom.lonColumn)} AS DOUBLE), CAST(${quoteIdent(
					geom.latColumn,
				)} AS DOUBLE))`;
			case "wkb":
				return `ST_GeomFromWKB(${quoteIdent(geom.column)})`;
			case "geojson-string":
				return `ST_GeomFromGeoJSON(${quoteIdent(geom.column)})`;
			default:
				return undefined;
		}
	}

	/** Run SQL, return an apache-arrow Table. */
	async query(sql: string): Promise<ArrowTable> {
		await this.init();
		if (!this.conn) throw new Error("DuckDBEngine: not initialized");
		return (await this.conn.query(sql)) as unknown as ArrowTable;
	}

	/** List currently registered logical tables. */
	listTables(): string[] {
		return Array.from(this.tables.keys());
	}

	/** Drop a registered table + any derived geom view. */
	async drop(name: string): Promise<void> {
		const ident = safeIdent(name);
		const entry = this.tables.get(ident);
		if (!this.conn) {
			this.tables.delete(ident);
			return;
		}
		if (entry?.geomView) {
			await this.conn.query(
				`DROP VIEW IF EXISTS ${quoteIdent(entry.geomView)}`,
			);
		}
		await this.conn.query(`DROP TABLE IF EXISTS ${quoteIdent(ident)}`);
		this.tables.delete(ident);
	}

	/** Tear down DB + worker. Idempotent. */
	async dispose(): Promise<void> {
		// Drain any in-flight init() before tearing down. Without this, a
		// dispose() that runs while bootstrap is still fetching the WASM
		// bundle would clear `this.conn`/`this.db`/`this.worker` (still
		// undefined) and skip cleanup. Bootstrap then completes and assigns
		// live resources to those fields — leaking a Worker forever.
		// Errors from a pending bootstrap are swallowed; we are tearing
		// down regardless.
		if (this.initPromise) {
			try {
				await this.initPromise;
			} catch {
				/* swallow — bootstrap failed; we still need to clean up */
			}
		}
		try {
			if (this.conn) {
				try {
					await this.conn.close();
				} catch {
					/* ignore */
				}
			}
			if (this.db) {
				try {
					await this.db.terminate();
				} catch {
					/* ignore */
				}
			}
			if (this.worker) {
				try {
					this.worker.terminate();
				} catch {
					/* ignore */
				}
			}
			if (this.workerObjectUrl) {
				try {
					URL.revokeObjectURL(this.workerObjectUrl);
				} catch {
					/* ignore */
				}
			}
		} finally {
			this.conn = undefined;
			this.db = undefined;
			this.worker = undefined;
			this.workerObjectUrl = undefined;
			this.initPromise = undefined;
			this.spatialLoaded = false;
			this.tables.clear();
		}
	}
}
