import { z } from "zod";
import { registerTool } from "./registry.js";

/**
 * Tool catalog entry — runtime lives in
 * `agent/executor/runners/geocode.ts`.
 *
 * Geocoding turns address-like columns into a point layer using the
 * OpenStreetMap Nominatim service. It is rate-limited (one request per
 * second per the public Nominatim usage policy), so the runner caps the
 * input at MAX_GEOCODE_ROWS and pauses between requests. Outputs are
 * layer-kind: a view containing every original column plus a freshly
 * built `geom` Point column derived from lon/lat coordinates returned
 * by Nominatim.
 *
 * IMPORTANT: pass ALL related address columns (street + city + state +
 * zip + country, in whatever combination the dataset has) — a single
 * column rarely produces accurate matches since street names are not
 * unique globally. Optionally bias the result to one country with the
 * `country_code` argument (ISO 3166-1 alpha-2: "us", "ca", "gb", etc.).
 */
registerTool({
	id: "geocode.address",
	description:
		"Geocode address-like columns to lat/lon points using OpenStreetMap Nominatim. " +
		'Pass `address_cols` as an ARRAY of columns to concatenate (e.g. ["street","city","state","zip"]). ' +
		"A single column rarely matches accurately because street names repeat globally. " +
		'Set `country_code` (ISO 3166-1 alpha-2: "us", "ca", "gb", "au"...) when the data is from a known region — ' +
		"this drastically improves match quality. " +
		'Set `region_hint` (e.g. "Keystone Heights, FL, USA" or "Cedar Key, FL, USA") WHENEVER only a single street/address column is present — ' +
		"it is appended to every row before querying Nominatim, scoping the search to one city/state. " +
		"CRITICAL: without region_hint a street-only column like 'Address' WILL fail to geocode because Nominatim cannot resolve 'Harvard Avenue' without knowing the city. " +
		"Always ask the user for the city/state if the dataset has only a street column and no region_hint was provided. " +
		"The output layer drops rows whose addresses fail to geocode. " +
		"Capped at 400 rows per call (≈ 7 minutes at Nominatim's 1 req/s rate limit).",
	args: z.object({
		layer: z.string(),
		address_cols: z.array(z.string().min(1)).min(1),
		country_code: z.string().length(2).optional(),
		region_hint: z.string().min(1).max(120).optional(),
	}),
	output_kind: "layer",
	examples: [
		{
			when: "Map customers from their street + city + state columns",
			args: {
				layer: "customers",
				address_cols: ["street", "city", "state"],
				country_code: "us",
			},
		},
		{
			when: "Map a community survey with only one Address column, all in Keystone Heights, FL",
			args: {
				layer: "survey",
				address_cols: ["Address"],
				country_code: "us",
				region_hint: "Keystone Heights, FL, USA",
			},
		},
		{
			when: "Map a survey with only one Address column, all in Cedar Key, FL",
			args: {
				layer: "survey",
				address_cols: ["Address"],
				country_code: "us",
				region_hint: "Cedar Key, FL, USA",
			},
		},
	],
});
