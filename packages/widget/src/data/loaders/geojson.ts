import { type Table, tableFromJSON } from "apache-arrow";
import type {
	BinaryInput,
	DataLoader,
	LoadResult,
	LoaderOptions,
} from "../contracts";
import { LoaderError } from "../contracts";
import {
	assertNonEmpty,
	deriveTableName,
	normalizeRows,
	toArrayBuffer,
} from "./_util";

const EXT_RE = /\.(geojson|json)$/i;

export const geojsonLoader: DataLoader = {
	id: "geojson",
	canLoad(filename: string): boolean {
		return EXT_RE.test(filename);
	},
	async load(
		file: BinaryInput,
		options: LoaderOptions = {},
	): Promise<LoadResult> {
		const { name, buffer } = await toArrayBuffer(file);
		assertNonEmpty(buffer, name);

		let parsed: unknown;
		try {
			const text = new TextDecoder("utf-8").decode(new Uint8Array(buffer));
			parsed = JSON.parse(text);
		} catch (err) {
			throw new LoaderError(
				"PARSE_ERROR",
				`GeoJSON parse failed for ${name}: ${describe(err)}`,
				{ cause: err },
			);
		}

		const features = collectFeatures(parsed);
		if (!features || features.length === 0) {
			throw new LoaderError(
				"INVALID_GEOMETRY",
				`${name}: no GeoJSON features found.`,
			);
		}

		const rows = features.map((f) => {
			const props =
				f &&
				typeof f === "object" &&
				f.properties &&
				typeof f.properties === "object"
					? (f.properties as Record<string, unknown>)
					: {};
			const geom = f && typeof f === "object" ? (f.geometry ?? null) : null;
			return {
				...props,
				geometry: geom == null ? null : JSON.stringify(geom),
			};
		});

		const normalized = normalizeRows(rows);
		let table: Table;
		try {
			table = tableFromJSON(normalized as Record<string, unknown>[]);
		} catch (err) {
			throw new LoaderError(
				"PARSE_ERROR",
				`GeoJSON → Arrow conversion failed for ${name}: ${describe(err)}`,
				{ cause: err },
			);
		}

		return {
			name: deriveTableName(name, options.tableName),
			table,
			geometry: { kind: "geojson-string", column: "geometry" },
			source: "geojson",
			filename: name,
		};
	},
};

interface FeatureLike {
	type?: unknown;
	properties?: unknown;
	geometry?: unknown;
}

// Per RFC 7946, a GeoJSON document may be a FeatureCollection, a Feature,
// a Geometry, or a GeometryCollection. We accept all four shapes.
const GEOMETRY_TYPES = new Set([
	"Point",
	"MultiPoint",
	"LineString",
	"MultiLineString",
	"Polygon",
	"MultiPolygon",
	"GeometryCollection",
]);

function collectFeatures(parsed: unknown): FeatureLike[] | null {
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as {
		type?: unknown;
		features?: unknown;
		geometry?: unknown;
	};
	if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
		return obj.features as FeatureLike[];
	}
	if (obj.type === "Feature") {
		return [obj as FeatureLike];
	}
	// Bare geometry: wrap it in a synthetic Feature so the rest of the
	// pipeline doesn't have to care about the wrapper level.
	if (typeof obj.type === "string" && GEOMETRY_TYPES.has(obj.type)) {
		return [{ type: "Feature", properties: {}, geometry: obj }];
	}
	return null;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
