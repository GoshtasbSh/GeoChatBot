/**
 * Ground-truth computation. For each fixture, compute the EXACT expected
 * answer for a set of canonical questions, so we can later compare the
 * model's plan execution to these values.
 */
const { DuckDBInstance } = require("@duckdb/node-api");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot";

const FIXTURES = {
	A: { path: "e2e/fixtures/audit-2026-05-16/clean_urban_points.csv", header: true, view: "A" },
	B: { path: "e2e/fixtures/audit-2026-05-16/mixed_geometry_polygons.csv", header: true, view: "B" },
	C: { path: "e2e/fixtures/audit-2026-05-16/latlon_with_dates.csv", header: true, view: "C" },
	D: { path: "e2e/fixtures/audit-2026-05-16/messy_real_world.csv", header: false, view: "D" },
	F: { path: "e2e/fixtures/audit-2026-05-16/huge_performance.csv", header: true, view: "F" },
	G: { path: "e2e/fixtures/audit-2026-05-16/international_unicode.csv", header: true, view: "G" },
	H: { path: "e2e/fixtures/audit-2026-05-16/timestamps_and_geom.csv", header: true, view: "H" },
};

function clean(rows) {
	return rows.map(r => {
		const o = {};
		for (const [k, v] of Object.entries(r)) {
			if (typeof v === "bigint") o[k] = Number(v);
			else if (v && typeof v === "object" && "value" in v && "scale" in v) {
				o[k] = Number(v.value) / Math.pow(10, v.scale);
			} else o[k] = v;
		}
		return o;
	});
}

async function main() {
	const inst = await DuckDBInstance.create(":memory:");
	const conn = await inst.connect();
	await conn.run("INSTALL spatial; LOAD spatial;");

	const truth = {};

	for (const [did, fx] of Object.entries(FIXTURES)) {
		const full = path.resolve(REPO, fx.path);
		await conn.run(`CREATE OR REPLACE TABLE ${fx.view} AS SELECT * FROM read_csv_auto('${full.replace(/'/g, "''")}', HEADER=${fx.header})`);
	}

	// Dataset A — clean urban points
	truth.A = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM A")).getRowObjectsJS())[0].n,
		category_counts: clean(await (await conn.runAndReadAll("SELECT category, COUNT(*) AS n FROM A GROUP BY category ORDER BY n DESC")).getRowObjectsJS()),
		mean_population: clean(await (await conn.runAndReadAll("SELECT AVG(population) AS mean FROM A")).getRowObjectsJS())[0].mean,
		max_population: clean(await (await conn.runAndReadAll("SELECT MAX(population) AS max FROM A")).getRowObjectsJS())[0].max,
		min_population: clean(await (await conn.runAndReadAll("SELECT MIN(population) AS min FROM A")).getRowObjectsJS())[0].min,
		top5_by_population: clean(await (await conn.runAndReadAll("SELECT name, population FROM A ORDER BY population DESC LIMIT 5")).getRowObjectsJS()),
		residential_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM A WHERE category='residential'")).getRowObjectsJS())[0].n,
	};

	// Dataset B — polygons
	truth.B = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM B")).getRowObjectsJS())[0].n,
		county_pop_top3: clean(await (await conn.runAndReadAll("SELECT county, pop_2020 FROM B ORDER BY pop_2020 DESC LIMIT 3")).getRowObjectsJS()),
		mean_income: clean(await (await conn.runAndReadAll("SELECT AVG(income_med) AS m FROM B")).getRowObjectsJS())[0].m,
		high_crime_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM B WHERE crime_rate_per_1k > 5")).getRowObjectsJS())[0].n,
		// Spatial: centroid of Alachua + total area
		alachua_centroid: clean(await (await conn.runAndReadAll("SELECT ST_AsText(ST_Centroid(ST_GeomFromText(geometry_wkt))) AS c FROM B WHERE county='Alachua'")).getRowObjectsJS())[0].c,
		total_area: clean(await (await conn.runAndReadAll("SELECT SUM(ST_Area(ST_GeomFromText(geometry_wkt))) AS a FROM B")).getRowObjectsJS())[0].a,
	};

	// Dataset C — lat/lon events
	truth.C = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM C")).getRowObjectsJS())[0].n,
		event_type_counts: clean(await (await conn.runAndReadAll("SELECT event_type, COUNT(*) AS n FROM C GROUP BY event_type ORDER BY n DESC")).getRowObjectsJS()),
		max_severity: clean(await (await conn.runAndReadAll("SELECT MAX(severity) AS m FROM C")).getRowObjectsJS())[0].m,
		null_severity_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM C WHERE severity IS NULL")).getRowObjectsJS())[0].n,
		severity_4_or_5_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM C WHERE severity >= 4")).getRowObjectsJS())[0].n,
		// Spatial: points within bbox around UF (Gainesville, FL)
		near_uf_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM C WHERE lat BETWEEN 29.4 AND 29.8 AND lon BETWEEN -82.6 AND -82.2")).getRowObjectsJS())[0].n,
	};

	// Dataset D — messy real world
	truth.D = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM D")).getRowObjectsJS())[0].n,
		status_counts: clean(await (await conn.runAndReadAll("SELECT column4 AS status, COUNT(*) AS n FROM D GROUP BY status ORDER BY n DESC LIMIT 6")).getRowObjectsJS()),
	};

	// Dataset F — 100k rows
	truth.F = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM F")).getRowObjectsJS())[0].n,
		category_count: clean(await (await conn.runAndReadAll("SELECT COUNT(DISTINCT category) AS n FROM F")).getRowObjectsJS())[0].n,
		mean_value_a: clean(await (await conn.runAndReadAll("SELECT AVG(value_a) AS m FROM F")).getRowObjectsJS())[0].m,
		max_value_a: clean(await (await conn.runAndReadAll("SELECT MAX(value_a) AS m FROM F")).getRowObjectsJS())[0].m,
		top5_categories: clean(await (await conn.runAndReadAll("SELECT category, COUNT(*) AS n FROM F GROUP BY category ORDER BY n DESC LIMIT 5")).getRowObjectsJS()),
	};

	// Dataset G — i18n
	truth.G = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM G")).getRowObjectsJS())[0].n,
		distinct_countries: clean(await (await conn.runAndReadAll("SELECT COUNT(DISTINCT pais) AS n FROM G")).getRowObjectsJS())[0].n,
		country_counts: clean(await (await conn.runAndReadAll("SELECT pais, COUNT(*) AS n FROM G GROUP BY pais ORDER BY n DESC LIMIT 5")).getRowObjectsJS()),
	};

	// Dataset H — timestamps + WKT
	truth.H = {
		row_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM H")).getRowObjectsJS())[0].n,
		category_counts: clean(await (await conn.runAndReadAll("SELECT category, COUNT(*) AS n FROM H GROUP BY category ORDER BY n DESC")).getRowObjectsJS()),
		mean_metric: clean(await (await conn.runAndReadAll("SELECT AVG(metric) AS m FROM H")).getRowObjectsJS())[0].m,
		over_50_count: clean(await (await conn.runAndReadAll("SELECT COUNT(*) AS n FROM H WHERE metric > 50")).getRowObjectsJS())[0].n,
	};

	const outPath = path.resolve(REPO, "audit-reports/ground-truth-2026-05-16.json");
	fs.writeFileSync(outPath, JSON.stringify(truth, null, 2));
	console.log("Ground truth written to:", outPath);
	console.log("\nSample values:");
	console.log("  A row_count =", truth.A.row_count);
	console.log("  A categories:", truth.A.category_counts.map(r => `${r.category}=${r.n}`).join(", "));
	console.log("  A mean_population =", truth.A.mean_population.toFixed(2));
	console.log("  A residential count =", truth.A.residential_count);
	console.log("  B alachua centroid =", truth.B.alachua_centroid);
	console.log("  B total area =", truth.B.total_area.toFixed(4));
	console.log("  C max severity =", truth.C.max_severity);
	console.log("  C severity >= 4 =", truth.C.severity_4_or_5_count);
	console.log("  C near UF (lat/lon bbox) =", truth.C.near_uf_count);
	console.log("  F row_count =", truth.F.row_count);
	console.log("  F mean value_a =", truth.F.mean_value_a.toFixed(2));
	console.log("  G distinct countries =", truth.G.distinct_countries);
	console.log("  G top countries:", truth.G.country_counts.map(r => `${r.pais}=${r.n}`).join(", "));
	console.log("  H mean metric =", truth.H.mean_metric.toFixed(2));
}

main().catch(e => { console.error(e); process.exit(1); });
