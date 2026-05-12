/**
 * AUDIT-004: SEC-005 regression — shapefile zip-bomb pre-check bypass.
 *
 * The shapefile loader's pre-check walks JSZip's central-directory entries
 * and sums `_data.uncompressedSize` BEFORE decompressing. A hostile zip
 * can omit those size fields, which silently skips the pre-check
 * (`totalUncompressed` stays 0). The post-decompress secondary cap is the
 * actual gate that fires in that case.
 *
 * This test mocks JSZip so:
 *   - The central-directory entry has NO `_data.uncompressedSize` field
 *     → pre-check passes with totalUncompressed = 0.
 *   - `entry.async("arraybuffer")` returns a buffer larger than the
 *     upload cap → post-decompress cap throws FILE_TOO_LARGE.
 */

import { describe, expect, it, vi } from "vitest";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

vi.mock("jszip", () => {
	type FakeEntry = {
		dir: boolean;
		async: (kind: "arraybuffer") => Promise<ArrowBufferLike>;
		// NOTE: NO `_data` field — that's the bypass we're testing.
	};
	// A 1-byte ArrayBuffer is enough to construct one — but we cap the actual
	// allocation via a getter so the test doesn't burn 200 MB of RAM for real.
	type ArrowBufferLike = ArrayBuffer;
	function makeOversizedBuffer(): ArrowBufferLike {
		// Allocate just over the cap. This is a real allocation; on machines
		// where this is unsafe, the test will OOM — but the cap is 200 MB and
		// Node test runners have at least 1 GB available by default.
		// Use byteLength reporting trick: return a real (cap+1)-byte ArrayBuffer.
		return new ArrayBuffer(MAX_UPLOAD_BYTES + 1024);
	}

	const fakeShp: FakeEntry = {
		dir: false,
		async: async () => makeOversizedBuffer(),
	};
	const fakeDbf: FakeEntry = {
		dir: false,
		async: async () => new ArrayBuffer(8),
	};
	const zip = {
		forEach(cb: (path: string, entry: FakeEntry) => void) {
			cb("points.shp", fakeShp);
			cb("points.dbf", fakeDbf);
		},
	};
	return {
		default: { loadAsync: async () => zip },
	};
});

describe("AUDIT-004 — shapefile post-decompress cap (SEC-005)", () => {
	it("rejects a decompressed payload that exceeds the upload cap, even when the pre-check missed it", async () => {
		const { shapefileLoader } = await import(
			"../../src/data/loaders/shapefile"
		);
		// Any non-empty buffer passes the EMPTY_FILE guard before JSZip
		// is invoked.
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
		await expect(
			shapefileLoader.load({ name: "bomb.zip", bytes }),
		).rejects.toMatchObject({
			code: "FILE_TOO_LARGE",
			message: expect.stringContaining("decompressed"),
		});
	});
});
