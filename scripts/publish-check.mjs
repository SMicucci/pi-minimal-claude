#!/usr/bin/env node
/**
 * Pre-publish validation for pi-minimal-claude.
 *
 *   node scripts/publish-check.mjs            # errors fail, warnings pass
 *   node scripts/publish-check.mjs --strict   # warnings fail too
 *
 * Checks the npm package, the Pi manifest, the dependency layout Pi requires for
 * host-provided packages, and the exact contents of `npm pack` tarball.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");

/** Packages Pi supplies to extensions; they must never be bundled. */
const HOST_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

const results = [];
const fail = (label, detail) => results.push({ level: "error", label, detail });
const warn = (label, detail) => results.push({ level: "warn", label, detail });
const pass = (label, detail) => results.push({ level: "ok", label, detail });

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

const pkg = readJson(join(root, "package.json"));

// --- basic npm metadata -----------------------------------------------------

for (const field of ["name", "version", "description", "license"]) {
	if (typeof pkg[field] === "string" && pkg[field].trim()) pass(`package.json ${field}`, pkg[field]);
	else fail(`package.json ${field}`, "missing or empty");
}

if (pkg.private === true) fail("package.json private", "remove `private` to publish");
else pass("package.json private", "not private");

if (pkg.license === "MIT" && !existsSync(join(root, "LICENSE"))) {
	fail("LICENSE file", "license field is MIT but no LICENSE file exists");
} else if (existsSync(join(root, "LICENSE"))) {
	const license = readFileSync(join(root, "LICENSE"), "utf-8");
	if (/^\s*MIT License/m.test(license)) pass("LICENSE file", "MIT License");
	else warn("LICENSE file", "missing a `MIT License` heading line");
} else {
	warn("LICENSE file", "no LICENSE file");
}

if (existsSync(join(root, "README.md"))) {
	const readme = readFileSync(join(root, "README.md"), "utf-8");
	if (/pi install/.test(readme)) pass("README install docs", "mentions `pi install`");
	else warn("README install docs", "no `pi install` instructions");
} else {
	fail("README.md", "missing");
}

// --- publish metadata (warn, strict-error) ---------------------------------

const metadata = [
	["repository.url", pkg.repository?.url, "git+https://github.com/<user>/<repo>.git"],
	["homepage", pkg.homepage, "https://github.com/<user>/<repo>#readme"],
	["bugs.url", pkg.bugs?.url, "https://github.com/<user>/<repo>/issues"],
	["author", pkg.author, "your name or GitHub handle"],
];

for (const [field, value, hint] of metadata) {
	if (typeof value === "string" && value.trim()) pass(`package.json ${field}`, value);
	else warn(`package.json ${field}`, `set it, expected something like ${hint}`);
}

if (typeof pkg.engines?.node === "string") pass("package.json engines.node", pkg.engines.node);
else warn("package.json engines.node", 'Pi requires node >=22.19.0; set `"engines": {"node": ">=22.19.0"}`');

// --- Pi package manifest ----------------------------------------------------

if (pkg.keywords?.includes("pi-package")) pass("pi-package keyword", "gallery eligible");
else fail("pi-package keyword", 'add "pi-package" to keywords');

const extensionPaths = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
if (extensionPaths.length === 0) fail("pi.extensions", "no extensions declared");

for (const entry of extensionPaths) {
	const target = resolve(root, entry);
	if (existsSync(target)) pass(`pi.extensions ${entry}`, "exists");
	else fail(`pi.extensions ${entry}`, "does not exist");
}

const agentDirs = Array.isArray(pkg.pi?.subagents?.agents) ? pkg.pi.subagents.agents : [];
if (agentDirs.length === 0) fail("pi.subagents.agents", "no agent directories declared");

for (const entry of agentDirs) {
	const target = resolve(root, entry);
	if (!existsSync(target)) {
		fail(`pi.subagents.agents ${entry}`, "does not exist");
		continue;
	}
	const agents = walk(target).filter((file) => file.endsWith(".md") && !file.endsWith(".chain.md"));
	if (agents.length === 0) fail(`pi.subagents.agents ${entry}`, "contains no agent .md files");
	else pass(`pi.subagents.agents ${entry}`, `${agents.length} agent(s)`);
}

// --- dependency layout ------------------------------------------------------

const dependencies = pkg.dependencies ?? {};
const peerDependencies = pkg.peerDependencies ?? {};
const bundledHostPackages = HOST_PACKAGES.filter((name) => name in dependencies);
if (bundledHostPackages.length > 0) {
	fail("host packages not bundled", `move to peerDependencies: ${bundledHostPackages.join(", ")}`);
} else {
	pass("host packages not bundled", "not in dependencies");
}

const sourceFiles = walk(join(root, "extensions")).filter((file) => file.endsWith(".ts"));
const importedHosts = new Set();
for (const file of sourceFiles) {
	const source = readFileSync(file, "utf-8");
	for (const name of HOST_PACKAGES) {
		if (new RegExp(`from\\s+["']${name.replace(/[/@]/g, "\\$&")}["']`).test(source)) {
			importedHosts.add(name);
		}
	}
}

for (const name of importedHosts) {
	if (peerDependencies[name] === "*") pass(`peerDependencies ${name}`, '"*"');
	else fail(`peerDependencies ${name}`, `imported by the extension but not declared as "*"`);
}

// --- files whitelist --------------------------------------------------------

const files = Array.isArray(pkg.files) ? pkg.files : [];
for (const required of ["agents", "extensions"]) {
	if (files.includes(required)) pass(`files ${required}`, "included");
	else fail(`files ${required}`, "add it to `files`");
}

// --- tarball contents -------------------------------------------------------

let packed = [];
try {
	const raw = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
	const parsed = JSON.parse(raw);
	packed = (Array.isArray(parsed) ? parsed[0] : parsed)?.files?.map((file) => file.path) ?? [];
	if (packed.length === 0) fail("npm pack", "tarball is empty");
	else pass("npm pack", `${packed.length} files, ${((Array.isArray(parsed) ? parsed[0] : parsed)?.size ?? 0)} bytes`);
} catch (error) {
	fail("npm pack", error instanceof Error ? error.message : String(error));
}

const wanted = ["package.json", "README.md", "LICENSE", "extensions/index.ts", "extensions/lib/config.ts"];
for (const path of wanted) {
	const found = packed.includes(path);
	if (found) pass(`tarball ${path}`, "included");
	else fail(`tarball ${path}`, "missing from the published tarball");
}

const agentFiles = packed.filter((path) => /^agents\/[^/]+\.md$/.test(path));
if (agentFiles.length >= 4) pass("tarball agents", `${agentFiles.length} agent file(s)`);
else fail("tarball agents", `expected at least 4 agent files, found ${agentFiles.length}`);

const leaked = packed.filter((path) => /^(test|scripts|node_modules)\//.test(path) || path.startsWith(".pi/"));
if (leaked.length > 0) fail("tarball isolation", `unwanted files: ${leaked.slice(0, 5).join(", ")}`);
else pass("tarball isolation", "no test/, scripts/ or .pi/ files");

// --- report -----------------------------------------------------------------

const errors = results.filter((result) => result.level === "error");
const warnings = results.filter((result) => result.level === "warn");
const glyphs = { ok: "  ok  ", warn: "  !   ", error: "  FAIL" };

for (const result of results) {
	const detail = result.detail ? ` — ${result.detail}` : "";
	console.log(`${glyphs[result.level]} ${result.label}${detail}`);
}

console.log(
	`\npublish-check: ${results.length - errors.length - warnings.length} ok, ${warnings.length} warning(s), ${errors.length} error(s)${strict ? " [strict]" : ""}`,
);

if (errors.length > 0 || (strict && warnings.length > 0)) {
	console.error(`\nNot ready to publish. Project root: ${relative(process.cwd(), root) || "."}${sep}`);
	process.exit(1);
}
