# Audit Fixtures — 2026-05-16

Mock CSV datasets generated for Phase 1 of the GeoChatBot audit. All data is
**synthetic** — no real PII, no real precise geometry, no scraped records.
Names like `Tester One`, `Synth User 12`, phone numbers like `(555) 010-0042`,
and addresses are intentionally non-resolvable. County polygons are
hand-rolled rough rectangles around centroids, NOT cartographic boundaries.

Generation script: `/tmp/gen_audit_fixtures.py` (uses `random.seed(42)` for
A/B/C/D/G/H and `random.seed(1337)` for F — fully reproducible).

## Index

### A — `clean_urban_points.csv` (200 rows)
Clean urban points-of-interest in Gainesville, FL. The happy-path baseline.
- **Columns:** `id, name, category, address, city, state, zip, population, area_sqkm, built_year`
- **Categories:** residential | commercial | industrial | parks | transit
- **Guarantees:** no nulls; 5-digit ZIPs in 32601–32612; realistic Gainesville street names

### B — `mixed_geometry_polygons.csv` (50 rows)
Florida county polygons with socioeconomic attributes.
- **Columns:** `county, state, geometry_wkt, pop_2020, income_med, unemployment_pct, crime_rate_per_1k`
- **Geometry:** simplified 5-vertex WKT POLYGONs (rough rectangles around centroid — NOT real cartographic boundaries)
- **Counties:** 50 real FL county names (Alachua, Marion, Duval, Orange, Miami-Dade, …)
- **Use case:** polygon rendering, choropleth, WKT parsing

### C — `latlon_with_dates.csv` (500 rows)
US-wide event records with intentional dirty-data injections.
- **Columns:** `event_id, lat, lon, event_type, event_date, severity, notes`
- **Bbox:** lat 24–49, lon −125 to −67 (continental US)
- **Defects:** ~10 rows with malformed dates (`3/15/2024`, `not a date`, `2024/13/45`, `tomorrow`), ~30 rows with empty severity, ~20% empty notes
- **Use case:** date-parser robustness, null handling, severity-aware filtering

### D — `messy_real_world.csv` (400 rows, **NO HEADER**)
Field-survey-style data, deliberately ungoverned. Tests header-inference and dirty-row tolerance.
- **Columns (positional):** `street_address, full_name, phone, status, dollar_amount, date`
- **Mess:** 4 phone formats (~10% blank), free-text status (`"REFUSED"`, `"Gated; no answer"`, long sentences), mixed currency (`"$1,250.00"`, `"$45"`, `"see notes"`, blank), 3 date formats (ISO, `M/D/YYYY`, `Month D YYYY`)
- **UTF-8 quirks:** em-dash `—`, curly quotes `“”`, NBSP, `ñ`, `é`, names like `María García`, `François O'Connell`, `Müller`
- **Use case:** header inference, encoding handling, free-text column detection

### E — `tiny/one_row.csv` + `tiny/header_only.csv`
Boundary fixtures for the small-input path.
- **`one_row.csv`:** header `id,name,lat,lon,value` + exactly 1 data row
- **`header_only.csv`:** same header + 0 data rows
- **Use case:** ensure parsers don't crash on minimal/empty inputs; verify "no data" UX state

### F — `huge_performance.csv` (100,000 rows)
Stress-test fixture for streaming, virtualization, and binning.
- **Columns:** `id, lat, lon, category, value_a, value_b`
- **Bbox:** continental US; 20 categorical buckets; `value_b` is Gaussian (μ=50, σ=15)
- **Seed:** `random.seed(1337)` (reproducible)
- **Use case:** scroll virtualization, sampling, aggregate-only rendering, memory ceiling

### G — `international_unicode.csv` (150 rows)
Multi-script names + RTL/CJK notes + worldwide coordinates.
- **Columns:** `id, name_multi, pais, lat, lon, notas`
- **Scripts:** Spanish (`María González`), Arabic RTL (`محمد العلي`, `ملاحظات قصيرة`), Chinese (`王伟`, `简短说明`)
- **Bbox:** lat −60 to 70, lon −180 to 180 (worldwide)
- **Use case:** font rendering, RTL layout, non-Latin search, world-projection map

### H — `timestamps_and_geom.csv` (300 rows)
Timezone-aware observations with redundant geometry.
- **Columns:** `obs_id, obs_ts, lat, lon, geom_wkt, metric, category`
- **Timestamps:** ISO 8601 with TZ offsets (`-05:00`, `-08:00`, `+00:00`, `+01:00`, …)
- **Geometry:** `POINT(lon lat)` WKT matching the lat/lon columns
- **Use case:** TZ-aware temporal filters, lat/lon vs WKT geometry-source preference, agreement checks

## Row-count verification

| File | Header? | Data rows |
|---|---|---|
| `clean_urban_points.csv` | yes | 200 |
| `mixed_geometry_polygons.csv` | yes | 50 |
| `latlon_with_dates.csv` | yes | 500 |
| `messy_real_world.csv` | **no** | 400 |
| `huge_performance.csv` | yes | 100,000 |
| `international_unicode.csv` | yes | 150 |
| `timestamps_and_geom.csv` | yes | 300 |
| `tiny/one_row.csv` | yes | 1 |
| `tiny/header_only.csv` | yes | 0 |
