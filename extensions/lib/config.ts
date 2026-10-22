/**
 * Runtime configuration for pi-minimal-claude.
 *
 * Pi's `keybindings.json` only maps built-in action ids, so extension
 * shortcuts cannot be rebound there. This module reads an optional
 * `minimalClaude` section from the effective Pi settings instead:
 *
 * ```json
 * {
 *   "minimalClaude": {
 *     "shortcuts": {
 *       "agentCycle": "alt+a",
 *       "agentCycleAlt": "alt+shift+tab",
 *       "approvalCycle": "alt+m"
 *     },
 *     "agentOrder": ["worker", "planner", "explorer", "debugger"],
 *     "mode": "manual"
 *   }
 * }
 * ```
 *
 * Environment overrides win over settings:
 *   PI_MINIMAL_CLAUDE_AGENT_CYCLE
 *   PI_MINIMAL_CLAUDE_AGENT_CYCLE_ALT
 *   PI_MINIMAL_CLAUDE_APPROVAL_CYCLE
 * Set a value to "off" (or false / null) to disable that shortcut.
 */

import { normalizeApprovalMode } from "./approval.ts";
import {
	DEFAULT_AGENT_CYCLE,
	DEFAULT_AGENT_CYCLE_ALT,
	DEFAULT_AGENT_ORDER,
	DEFAULT_APPROVAL_CYCLE,
	type ApprovalMode,
} from "./types.ts";

export interface ShortcutConfig {
	agentCycle?: string;
	agentCycleAlt?: string;
	approvalCycle?: string;
}

export interface MinimalClaudeConfig {
	shortcuts: ShortcutConfig;
	agentOrder: string[];
	mode?: ApprovalMode;
}

export interface ConfigResult {
	config: MinimalClaudeConfig;
	warnings: string[];
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

const SYMBOLS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""));

const OFF_VALUES = new Set(["", "off", "none", "false", "disabled", "no"]);

function isBaseKey(part: string): boolean {
	if (/^[a-z]$/.test(part) || /^[0-9]$/.test(part)) return true;
	if (SPECIAL_KEYS.has(part.toLowerCase())) return true;
	return SYMBOLS.has(part);
}

/**
 * Validate a Pi key id: one base key with optional `ctrl`/`shift`/`alt`/`super`
 * modifiers, for example `alt+shift+tab` or `ctrl+shift+g`.
 */
export function isValidKeyId(value: string): boolean {
	const parts = value.split("+").map((part) => part.trim());
	const base = parts.pop();
	if (!base || !isBaseKey(base)) return false;

	const seen = new Set<string>();
	for (const modifier of parts) {
		const normalized = modifier.toLowerCase();
		if (!MODIFIERS.has(normalized) || seen.has(normalized)) return false;
		seen.add(normalized);
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseShortcut(
	value: unknown,
	fallback: string | undefined,
	label: string,
	warnings: string[],
): string | undefined {
	if (value === undefined) return fallback;
	if (value === false || value === null) return undefined;
	if (typeof value !== "string") {
		warnings.push(`minimalClaude.${label}: expected a key string, using ${fallback ?? "none"}`);
		return fallback;
	}

	const trimmed = value.trim();
	if (OFF_VALUES.has(trimmed.toLowerCase())) return undefined;
	if (!isValidKeyId(trimmed)) {
		warnings.push(`minimalClaude.${label}: invalid key "${trimmed}", using ${fallback ?? "none"}`);
		return fallback;
	}
	return trimmed;
}

export function readConfig(rawSettings: unknown, env: NodeJS.ProcessEnv = process.env): ConfigResult {
	const warnings: string[] = [];
	const root = isRecord(rawSettings) && isRecord(rawSettings.minimalClaude) ? rawSettings.minimalClaude : {};
	const rawShortcuts = isRecord(root.shortcuts) ? root.shortcuts : {};

	const setting = (envName: string, key: string): unknown => {
		const fromEnv = env[envName];
		if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
		return rawShortcuts[key];
	};

	const shortcuts: ShortcutConfig = {
		agentCycle: parseShortcut(
			setting("PI_MINIMAL_CLAUDE_AGENT_CYCLE", "agentCycle"),
			DEFAULT_AGENT_CYCLE,
			"shortcuts.agentCycle",
			warnings,
		),
		agentCycleAlt: parseShortcut(
			setting("PI_MINIMAL_CLAUDE_AGENT_CYCLE_ALT", "agentCycleAlt"),
			DEFAULT_AGENT_CYCLE_ALT,
			"shortcuts.agentCycleAlt",
			warnings,
		),
		approvalCycle: parseShortcut(
			setting("PI_MINIMAL_CLAUDE_APPROVAL_CYCLE", "approvalCycle"),
			DEFAULT_APPROVAL_CYCLE,
			"shortcuts.approvalCycle",
			warnings,
		),
	};

	const configuredOrder = Array.isArray(root.agentOrder)
		? root.agentOrder
				.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
				.map((name) => name.trim())
		: [];

	const mode = normalizeApprovalMode(typeof root.mode === "string" ? root.mode : undefined);

	return {
		config: {
			shortcuts,
			agentOrder: configuredOrder.length > 0 ? configuredOrder : [...DEFAULT_AGENT_ORDER],
			mode,
		},
		warnings,
	};
}
