import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	transpilePackages: ["@geochatbot/widget"],
	// The widget geocoder calls the US Census Bureau geocoder via a
	// same-origin path (`/api/census-geocode/*`) because the Census API
	// does not emit Access-Control-Allow-Origin, so direct browser fetches
	// are blocked by CORS. The widget's standalone Vite dev server proxies
	// this in vite.config.ts; this app is served by Next.js, so the host
	// proxy must live here too — otherwise every Census call 404s to the
	// Next.js page handler and all geocoding silently falls through.
	// Rewrites proxy server-side, so the browser only ever talks to
	// same-origin and CORS never applies.
	async rewrites() {
		return [
			{
				source: "/api/census-geocode/:path*",
				destination: "https://geocoding.geo.census.gov/geocoder/:path*",
			},
		];
	},
	// The embeddable widget bundle is served from /widget/* and loaded as a
	// cross-origin ES module from other sites (the README/docs embed snippet).
	// Module scripts (and their lazily-imported chunks) are fetched in CORS
	// mode, so the responses must allow any origin or the browser blocks them.
	async headers() {
		return [
			{
				source: "/widget/:path*",
				headers: [
					{ key: "Access-Control-Allow-Origin", value: "*" },
					{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
					{ key: "Cache-Control", value: "public, max-age=3600" },
				],
			},
		];
	},
};

export default nextConfig;
