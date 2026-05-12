import { describe, expect, it } from "vitest";
import { detectLatLon } from "../../src/data/loaders/_util.js";

describe("detectLatLon", () => {
	it("detects classic latitude/longitude column names", () => {
		const enc = detectLatLon([
			{ latitude: 29.6, longitude: -82.3, x: 1 },
			{ latitude: 30.0, longitude: -83.0, x: 2 },
		]);
		expect(enc).toEqual({
			kind: "lonlat",
			latColumn: "latitude",
			lonColumn: "longitude",
		});
	});

	it("detects short lat/lon synonyms case-insensitively", () => {
		const enc = detectLatLon([
			{ LAT: 1, LON: 2 },
			{ LAT: 3, LON: 4 },
		]);
		expect(enc?.kind).toBe("lonlat");
		if (enc?.kind === "lonlat") {
			expect(enc.latColumn).toBe("LAT");
			expect(enc.lonColumn).toBe("LON");
		}
	});

	it("detects the `lng` synonym for longitude", () => {
		const enc = detectLatLon([{ lat: 0.5, lng: 1.5 }]);
		expect(enc).toEqual({ kind: "lonlat", latColumn: "lat", lonColumn: "lng" });
	});

	it("detects the `long` synonym for longitude", () => {
		const enc = detectLatLon([{ Latitude: 5, Long: -120 }]);
		expect(enc?.kind).toBe("lonlat");
	});

	it("detects x/y when no other names are present", () => {
		const enc = detectLatLon([
			{ id: 1, x: 10, y: 20 },
			{ id: 2, x: 11, y: 21 },
		]);
		expect(enc).toEqual({ kind: "lonlat", lonColumn: "x", latColumn: "y" });
	});

	it('accepts numeric strings ("29.6") as valid lat/lon', () => {
		const enc = detectLatLon([
			{ lat: "29.6", lon: "-82.3" },
			{ lat: "30.0", lon: "-83.0" },
		]);
		expect(enc?.kind).toBe("lonlat");
	});

	it("rejects when only one of lat/lon is present", () => {
		expect(detectLatLon([{ latitude: 29.6 }])).toBeUndefined();
		expect(detectLatLon([{ longitude: -82.3 }])).toBeUndefined();
	});

	it("rejects when latitude is out of range", () => {
		expect(detectLatLon([{ lat: 95, lon: -82 }])).toBeUndefined();
	});

	it("rejects when longitude is out of range", () => {
		expect(detectLatLon([{ lat: 29, lon: 200 }])).toBeUndefined();
	});

	it("rejects when values are non-numeric strings", () => {
		expect(detectLatLon([{ lat: "north", lon: "west" }])).toBeUndefined();
	});

	it("rejects when noGeometry option is set even if columns match", () => {
		expect(
			detectLatLon([{ lat: 1, lon: 2 }], { noGeometry: true }),
		).toBeUndefined();
	});

	it("honors explicit latColumn/lonColumn overrides", () => {
		const enc = detectLatLon([{ a: 29, b: -82, lat: 0, lon: 0 }], {
			latColumn: "a",
			lonColumn: "b",
		});
		expect(enc).toEqual({ kind: "lonlat", latColumn: "a", lonColumn: "b" });
	});

	it("returns undefined when overrides reference non-existent columns", () => {
		expect(
			detectLatLon([{ a: 29, b: -82 }], { latColumn: "nope", lonColumn: "b" }),
		).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(detectLatLon([])).toBeUndefined();
	});

	it("returns undefined when all sampled rows have null lat/lon", () => {
		expect(
			detectLatLon([
				{ lat: null, lon: null },
				{ lat: null, lon: null },
			]),
		).toBeUndefined();
	});

	it("skips rows with one null side and detects geometry from valid rows", () => {
		// Regression for the `lat == null && lon == null` bug: a footer or
		// sparse row with only one populated coord must not poison the
		// detection of an otherwise-valid dataset.
		const enc = detectLatLon([
			{ lat: 29.6, lon: -82.3 },
			{ lat: 30.1, lon: -82.4 },
			{ lat: null, lon: -82.0 }, // half-populated row — must be skipped
			{ lat: 30.2, lon: null }, // half-populated row — must be skipped
			{ lat: 30.5, lon: -82.5 },
		]);
		expect(enc).toEqual({ kind: "lonlat", latColumn: "lat", lonColumn: "lon" });
	});

	it("detects underscore-suffixed variants used by USGS / Census exports", () => {
		expect(detectLatLon([{ latitude_dd: 29.6, longitude_dd: -82.3 }])).toEqual({
			kind: "lonlat",
			latColumn: "latitude_dd",
			lonColumn: "longitude_dd",
		});
	});

	it("detects the ArcGIS POINT_X / POINT_Y export convention", () => {
		expect(detectLatLon([{ POINT_X: -82.3, POINT_Y: 29.6 }])).toEqual({
			kind: "lonlat",
			latColumn: "POINT_Y",
			lonColumn: "POINT_X",
		});
	});

	it("detects y_coord / x_coord", () => {
		expect(detectLatLon([{ x_coord: -82.3, y_coord: 29.6 }])).toEqual({
			kind: "lonlat",
			latColumn: "y_coord",
			lonColumn: "x_coord",
		});
	});

	// ── AUDIT-002 column-intelligence expansion ─────────────────────────────
	// Regression suite for the "any file added to the bot can be parsed"
	// requirement. Each block exercises a real-world column-naming
	// convention the bot encountered in shared datasets but used to miss.

	it("detects GBIF / iNaturalist `decimalLatitude` / `decimalLongitude`", () => {
		expect(
			detectLatLon([{ decimalLatitude: 29.6, decimalLongitude: -82.3 }]),
		).toEqual({
			kind: "lonlat",
			latColumn: "decimalLatitude",
			lonColumn: "decimalLongitude",
		});
	});

	it("detects snake_case `decimal_latitude` / `decimal_longitude`", () => {
		expect(
			detectLatLon([{ decimal_latitude: 29.6, decimal_longitude: -82.3 }]),
		).toEqual({
			kind: "lonlat",
			latColumn: "decimal_latitude",
			lonColumn: "decimal_longitude",
		});
	});

	it("detects GPS-prefixed columns from device exports", () => {
		expect(detectLatLon([{ gps_lat: 29.6, gps_lon: -82.3 }])).toEqual({
			kind: "lonlat",
			latColumn: "gps_lat",
			lonColumn: "gps_lon",
		});
		expect(
			detectLatLon([{ gps_latitude: 29.6, gps_longitude: -82.3 }]),
		).toEqual({
			kind: "lonlat",
			latColumn: "gps_latitude",
			lonColumn: "gps_longitude",
		});
	});

	it("detects geo-prefixed and pos-prefixed columns", () => {
		expect(detectLatLon([{ geo_lat: 29.6, geo_lon: -82.3 }])).toEqual({
			kind: "lonlat",
			latColumn: "geo_lat",
			lonColumn: "geo_lon",
		});
		expect(detectLatLon([{ pos_lat: 29.6, pos_lng: -82.3 }])).toEqual({
			kind: "lonlat",
			latColumn: "pos_lat",
			lonColumn: "pos_lng",
		});
	});

	it("falls back to substring match when no exact alias is present", () => {
		// `Site_Latitude_DD_NAD83` is not in the alias list, but it contains
		// 'latitude' so tier-2 fallback picks it up; range validation passes.
		expect(
			detectLatLon([
				{ Site_Latitude_DD_NAD83: 29.6, Site_Longitude_DD_NAD83: -82.3 },
			]),
		).toEqual({
			kind: "lonlat",
			latColumn: "Site_Latitude_DD_NAD83",
			lonColumn: "Site_Longitude_DD_NAD83",
		});
	});

	it("substring fallback still respects range validation", () => {
		// `longitudinal_study_id` contains 'longitud' substring but the
		// values aren't geographic — range check rejects.
		expect(
			detectLatLon([
				{ patient_latitude_score: 0.95, longitudinal_study_id: 1024 },
			]),
		).toBeUndefined();
	});

	it("never returns the same column for both lat and lon", () => {
		// A pathological case where one column matches both regexes
		// (shouldn't happen with real data, but defends against future
		// regex changes).
		const enc = detectLatLon([{ latlong_combined: 1.0 }]);
		expect(enc).toBeUndefined();
	});

	it("tier-1 exact match wins over tier-2 substring when both present", () => {
		// `latitude` (exact) and `geo_latitude_str` (substring) both exist;
		// the exact-alias match should be preferred. This is implicit but
		// worth pinning so a future refactor doesn't silently swap priority.
		const enc = detectLatLon([
			{ latitude: 29.6, longitude: -82.3, geo_latitude_str: "x" },
		]);
		expect(enc?.kind).toBe("lonlat");
		if (enc?.kind === "lonlat") {
			expect(enc.latColumn).toBe("latitude");
			expect(enc.lonColumn).toBe("longitude");
		}
	});
});
