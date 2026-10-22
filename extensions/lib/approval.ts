import { relative, resolve, sep } from "node:path";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { judge, judgeEnabled } from "./judge.ts";
import { APPROVAL_MODES, type ApprovalMode, type Runtime } from "./types.ts";

/** Tools that never need approval: reads, the plan protocol, delegation. */
const ALWAYS_ALLOWED = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"plan_write",
	"plan_task",
	"explore",
	"subagent",
]);

/** Tools that modify files and therefore honour `code-only`. */
const FILE_WRITES = new Set(["edit", "write", "debug_print"]);

const ALIASES: Record<string, ApprovalMode> = {
	manual: "manual",
	ask: "manual",
	"code-only": "code-only",
	code: "code-only",
	"auto-write": "code-only",
	write: "code-only",
	auto: "auto",
	"full-auto": "auto",
	yolo: "auto",
};

export function normalizeApprovalMode(value: string | undefined): ApprovalMode | undefined {
	if (!value) return undefined;
	return ALIASES[value.trim().toLowerCase()];
}

export function approvalModeLabel(mode: ApprovalMode): string {
	switch (mode) {
		case "manual":
			return "manual (confirm every change)";
		case "code-only":
			return "code-only (auto-approve edits inside the workspace)";
		case "auto":
			return "auto (judge risky calls, confirm the rest)";
	}
}

/** Short system-prompt section describing the active approval mode. */
export function approvalPromptSection(mode: ApprovalMode): string {
	const rules: Record<ApprovalMode, string> = {
		manual: "Every non-read tool call needs explicit user approval. Batch work into few, well-explained calls.",
		"code-only":
			"File edits inside the workspace are pre-approved. Anything else (shell, network, paths outside the workspace) needs user approval.",
		auto: "Local reversible calls run automatically. Risky or irreversible calls are judged, then confirmed with the user.",
	};
	return `<approval-mode name="${mode}">\n${rules[mode]}\n</approval-mode>`;
}

function isInside(root: string, target: string): boolean {
	const base = resolve(root);
	const full = resolve(root, target);
	return full === base || full.startsWith(base + sep);
}

function preview(input: Record<string, unknown>): string {
	const json = JSON.stringify(input);
	if (!json) return "";
	return json.length > 400 ? `${json.slice(0, 400)}...` : json;
}

export interface GateOptions {
	runtime: Runtime;
	/** Returns a block reason when the call touches read-only plan files. */
	planGuard?: (toolName: string, input: Record<string, unknown>) => string | undefined;
	/** True inside a pi-subagents child process. */
	isSubagentChild: () => boolean;
}

/**
 * Decide whether a tool call may run.
 *
 * Returns `undefined` to let the call proceed, or `{ block, reason }` to stop
 * it. User confirmations happen here, before the call executes.
 */
export async function gateToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	options: GateOptions,
): Promise<ToolCallEventResult | undefined> {
	const toolName = event.toolName;
	const input = (event.input ?? {}) as Record<string, unknown>;

	const planBlock = options.planGuard?.(toolName, input);
	if (planBlock) return { block: true, reason: planBlock };

	if (ALWAYS_ALLOWED.has(toolName)) return undefined;

	const child = options.isSubagentChild();
	let mode = options.runtime.mode;
	// A delegated child has no UI and was already approved by its parent: the
	// strictest mode it can run under is `code-only`.
	if (child && mode === "manual") mode = "code-only";

	const path = typeof input.path === "string" ? input.path : undefined;
	const writesInsideWorkspace =
		FILE_WRITES.has(toolName) && path !== undefined && isInside(ctx.cwd, path);

	if (writesInsideWorkspace && (mode === "code-only" || mode === "auto")) return undefined;

	if (mode === "auto") {
		const verdict = await judge(
			{ tool: toolName, input: JSON.stringify(input).slice(0, 1500), cwd: ctx.cwd },
			"risky",
			"Is this tool call risky?",
			"yes: irreversible, outside the workspace, destructive, or sends data over the network",
			"no: local and reversible",
			ctx.signal,
		);
		if (verdict.ok && verdict.p < 0.2) return undefined;
	}

	if (!ctx.hasUI) {
		// Children were approved when they were spawned; the parent already
		// runs this same gate for their side effects.
		if (child) return undefined;
		return {
			block: true,
			reason: `"${toolName}" needs approval (approval mode: ${mode}) but no UI is available. Use /mode code-only or /mode auto.`,
		};
	}

	const where = path ? `\n\npath: ${relative(ctx.cwd, resolve(ctx.cwd, path)) || "."}` : "";
	const reason =
		mode === "manual" || !judgeEnabled()
			? ""
			: "\n\n(judge was not conclusive)";
	const ok = await ctx.ui.confirm(
		`${toolName}?`,
		`${preview(input)}${where}${reason}\n\nApproval mode: ${mode}`,
	);
	if (!ok) return { block: true, reason: "Denied by the user" };
	return undefined;
}

/** Next approval mode in the canonical cycle. */
export function nextApprovalMode(current: ApprovalMode): ApprovalMode {
	const index = APPROVAL_MODES.indexOf(current);
	return APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] as ApprovalMode;
}

export function approvalStatusText(mode: ApprovalMode): string {
	return `mode:${mode}`;
}
