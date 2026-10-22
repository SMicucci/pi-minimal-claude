import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import {
	THINKING_LEVELS,
	type AgentDefinition,
	type ThinkingLevel,
} from "./types.ts";

/**
 * Agent files follow the pi-subagents format: YAML frontmatter on top, system
 * prompt below. Only the keys this package understands are parsed.
 */

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseScalar(value: string): string | string[] {
	const trimmed = value.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((part) => unquote(part))
			.filter(Boolean);
	}
	return unquote(trimmed);
}

function asString(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function asList(value: string | string[] | undefined): string[] {
	if (Array.isArray(value)) return value.filter(Boolean);
	if (!value) return [];
	return value
		.split(",")
		.map((part) => unquote(part))
		.filter(Boolean);
}

export function parseAgentFile(text: string, path: string): AgentDefinition | undefined {
	const lines = text.split(/\r?\n/);
	const data: Record<string, string | string[]> = {};
	let body = text;

	if (lines[0]?.trim() === "---") {
		let end = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i]?.trim() === "---") {
				end = i;
				break;
			}
		}
		if (end > 0) {
			let listKey: string | undefined;
			for (let i = 1; i < end; i++) {
				const raw = lines[i] ?? "";
				if (!raw.trim() || raw.trim().startsWith("#")) continue;

				const listItem = raw.match(/^\s*-\s+(.*)$/);
				if (listItem && listKey) {
					const current = data[listKey];
					if (Array.isArray(current)) current.push(unquote(listItem[1] ?? ""));
					continue;
				}

				const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
				if (!kv) continue;
				const key = kv[1] as string;
				const value = (kv[2] ?? "").trim();
				if (value === "") {
					listKey = key;
					data[key] = [];
				} else {
					listKey = undefined;
					data[key] = parseScalar(value);
				}
			}
			body = lines.slice(end + 1).join("\n").trim();
		}
	}

	if (String(asString(data.disabled) ?? "").toLowerCase() === "true") return undefined;

	const name = asString(data.name) || basename(path, ".md");
	if (!name) return undefined;

	const rawThinking = asString(data.thinking);
	const thinking = THINKING_LEVELS.includes(rawThinking as ThinkingLevel)
		? (rawThinking as ThinkingLevel)
		: undefined;

	return {
		name,
		description: asString(data.description) ?? "",
		tools: asList(data.tools),
		model: asString(data.model),
		provider: asString(data.provider),
		thinking,
		body,
		path,
	};
}

/** Recursively collect agent markdown files, skipping chain files and noise. */
export function collectAgentFiles(dir: string, out: string[], depth = 0): void {
	if (depth > 8 || !existsSync(dir)) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectAgentFiles(full, out, depth + 1);
		} else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
			out.push(full);
		}
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/** Extra agent roots from `PI_AGENT_DIRS` (path-delimiter separated). */
function extraAgentDirs(): string[] {
	const raw = process.env.PI_AGENT_DIRS;
	if (!raw) return [];
	return raw
		.split(delimiter)
		.map((part) => part.trim())
		.filter(Boolean)
		.map(expandHome);
}

/**
 * Discovery roots, lowest priority first; a later root wins on a name clash:
 *
 * 1. `<packageRoot>/agents` — defaults shipped by this package
 * 2. `~/.pi/agent/agents` — user agents
 * 3. `<cwd>/.agents` — legacy project agents (only when trusted)
 * 4. `<cwd>/.pi/agents` — project agents (only when trusted)
 * 5. `PI_AGENT_DIRS` — explicit escape hatch, highest priority
 */
export function discoverAgents(
	cwd: string,
	options: { packageRoot: string; trusted: boolean },
): Map<string, AgentDefinition> {
	const roots: string[] = [
		join(options.packageRoot, "agents"),
		join(homedir(), ".pi", "agent", "agents"),
	];
	if (options.trusted) {
		roots.push(join(cwd, ".agents"), join(cwd, ".pi", "agents"));
	}
	roots.push(...extraAgentDirs());

	const files: string[] = [];
	for (const root of roots) collectAgentFiles(root, files);

	const agents = new Map<string, AgentDefinition>();
	for (const file of files) {
		try {
			const agent = parseAgentFile(readFileSync(file, "utf-8"), file);
			if (agent) agents.set(agent.name, agent);
		} catch {
			// Unreadable or malformed agent files are ignored on purpose.
		}
	}
	return agents;
}
