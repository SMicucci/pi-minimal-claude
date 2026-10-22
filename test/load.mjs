/**
 * Loader parity check: load the extension through Pi's own extension loader
 * (jiti + host module mapping), not just raw jiti. Fails on load errors and on
 * the manifest mistakes Pi reports as warnings (e.g. host packages listed as
 * dependencies).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("..", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "pi-minimal-claude-load-"));

try {
	const result = await discoverAndLoadExtensions(
		[join(root, "extensions", "index.ts")],
		root,
		join(sandbox, "agent"),
	);

	assert.deepEqual(result.errors, [], `load errors: ${JSON.stringify(result.errors, null, 2)}`);
	assert.deepEqual(result.warnings ?? [], [], `load warnings: ${JSON.stringify(result.warnings, null, 2)}`);
	assert.equal(result.extensions.length, 1, "expected exactly one loaded extension");

	console.log(`load: 1 extension, 0 errors, 0 warnings`);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
