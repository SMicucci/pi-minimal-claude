/**
 * pi-minimal-claude
 *
 * Exposes four agent definitions (`agents/*.md`, visible in the package root)
 * as switchable main-session modes, and gates tool calls with one of three
 * approval modes: `manual`, `code-only`, `auto`.
 *
 *   /agent [name|list|off|cycle]   switch agent (tools, model, thinking, prompt)
 *   /mode  [manual|code|auto|list]  switch approval mode
 *   /plan                          activate the planner
 *   /run                           activate the worker on the active plan
 *
 * Shortcuts (defaults, rebindable from settings `minimalClaude.shortcuts`):
 *   alt+shift+tab  cycle agents
 *   ctrl+shift+a   cycle agents (alternate)
 *   alt+m          cycle approval modes
 * Flags: --agent <name>, --approval-mode <mode>.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyId } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	approvalModeLabel,
	approvalPromptSection,
	approvalStatusText,
	gateToolCall,
	nextApprovalMode,
	normalizeApprovalMode,
} from "./lib/approval.ts";
import { judge, judgeEnabled } from "./lib/judge.ts";
import { activePlanFile, discardPlan, planGuard, registerPlanTools } from "./lib/plan.ts";
import { readConfig } from "./lib/config.ts";
import { createAgentSwitcher } from "./lib/switcher.ts";
import {
	APPROVAL_MODES,
	DEFAULT_AGENT_ORDER,
	ENTRY_APPROVAL,
	type ApprovalMode,
	type Runtime,
} from "./lib/types.ts";

const APPROVAL_ENTRY = ENTRY_APPROVAL;
const MODE_ALIASES_ENV = "PI_APPROVAL_MODE";

function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function isSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

export default function minimalClaude(pi: ExtensionAPI): void {
	if (process.env.PI_MINIMAL_CLAUDE_DISABLED === "1") return;

	const runtime: Runtime = {
		packageRoot: packageRoot(),
		agents: new Map(),
		mode: normalizeApprovalMode(process.env[MODE_ALIASES_ENV] ?? process.env.PI_MODE) ?? "manual",
		agentOrder: [...DEFAULT_AGENT_ORDER],
		planPending: false,
	};

	const switcher = createAgentSwitcher(pi, runtime);

	// ---------------------------------------------------------------- approval

	function updateModeStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("approval", ctx.ui.theme.fg("accent", approvalStatusText(runtime.mode)));
	}

	function setMode(mode: ApprovalMode, ctx: ExtensionContext, persist = true): void {
		runtime.mode = mode;
		// Children inherit the mode through the environment, like pi-subagents does.
		process.env[MODE_ALIASES_ENV] = mode;
		process.env.PI_MODE = mode === "code-only" ? "auto-write" : mode === "auto" ? "full-auto" : mode;
		updateModeStatus(ctx);
		if (persist) pi.appendEntry(APPROVAL_ENTRY, { mode });
	}

	function setModeByName(value: string, ctx: ExtensionContext, persist = true): boolean {
		const mode = normalizeApprovalMode(value);
		if (!mode) {
			ctx.ui.notify(`Unknown approval mode "${value}". Use: ${APPROVAL_MODES.join(", ")}`, "error");
			return false;
		}
		setMode(mode, ctx, persist);
		ctx.ui.notify(`Approval mode: ${approvalModeLabel(mode)}`, "info");
		return true;
	}

	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		const mode = nextApprovalMode(runtime.mode);
		setMode(mode, ctx);
		ctx.ui.notify(`Approval mode: ${approvalModeLabel(mode)}`, "info");
	}

	async function selectMode(ctx: ExtensionContext): Promise<void> {
		const labels = APPROVAL_MODES.map((mode) => {
			const suffix = runtime.mode === mode ? " (active)" : "";
			return `${mode}${suffix} — ${approvalModeLabel(mode)}`;
		});
		const choice = await ctx.ui.select("Approval mode", labels);
		if (!choice) return;
		const mode = normalizeApprovalMode(choice.split(" — ")[0]?.replace(" (active)", "").trim());
		if (mode) setMode(mode, ctx);
	}

	// ---------------------------------------------------------------- config

	/**
	 * Read settings and register the configured shortcuts.
	 *
	 * `pi.getSettings()` is not initialized during extension load, so this runs
	 * from `session_start`, which Pi emits before it collects extension
	 * shortcuts (`interactive-mode.setupExtensionShortcuts`).
	 */
	function applyConfig(ctx: ExtensionContext) {
		const { config, warnings } = readConfig(pi.getSettings() as unknown, process.env);
		runtime.agentOrder = config.agentOrder;
		for (const warning of warnings) ctx.ui.notify(warning, "warning");

		if (process.env.PI_MINIMAL_CLAUDE_SHORTCUTS === "off") return config;

		const bindings: Array<{
			key: string | undefined;
			description: string;
			run: (shortcutCtx: ExtensionContext) => Promise<void>;
		}> = [
			{
				key: config.shortcuts.agentCycle,
				description: "Cycle agent (pi-minimal-claude)",
				run: (shortcutCtx) => switcher.cycle(shortcutCtx),
			},
			{
				key: config.shortcuts.agentCycleAlt,
				description: "Cycle agent, alternate key (pi-minimal-claude)",
				run: (shortcutCtx) => switcher.cycle(shortcutCtx),
			},
			{
				key: config.shortcuts.approvalCycle,
				description: "Cycle approval mode (pi-minimal-claude)",
				run: (shortcutCtx) => cycleMode(shortcutCtx),
			},
		];

		const used = new Set<string>();
		for (const binding of bindings) {
			if (!binding.key) continue;
			const normalized = binding.key.toLowerCase();
			if (used.has(normalized)) {
				ctx.ui.notify(`Duplicate shortcut "${binding.key}": ${binding.description} skipped`, "warning");
				continue;
			}
			used.add(normalized);
			pi.registerShortcut(binding.key as KeyId, {
				description: binding.description,
				handler: async (shortcutCtx) => {
					await binding.run(shortcutCtx);
				},
			});
		}
		return config;
	}

	// ---------------------------------------------------------------- plan flow

	async function runActivePlan(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		const file = activePlanFile(ctx.cwd);
		if (!file) {
			ctx.ui.notify("No active plan. Activate the planner with /plan first.", "warning");
			return;
		}
		const activated = await switcher.activate("worker", ctx);
		if (!activated) return;
		pi.sendUserMessage(
			`Execute the active plan (${basename(file)}) using plan_task. Verify each task with evidence.`,
		);
	}

	// ---------------------------------------------------------------- wiring

	pi.registerFlag("agent", {
		description: "Start with an agent from the agents directory",
		type: "string",
	});

	pi.registerFlag("approval-mode", {
		description: "Start with approval mode manual | code-only | auto",
		type: "string",
	});

	pi.registerCommand("agent", {
		description: "Switch agent: /agent [worker|planner|explorer|debugger]",
		getArgumentCompletions: (prefix) =>
			[...switcher.names(), "list", "off", "cycle"]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const value = args.trim();

			// No name: expose the agents loaded from the agents directory.
			if (!value) return switcher.select(ctx);

			if (value === "list") {
				const names = switcher.names();
				if (names.length === 0) {
					ctx.ui.notify(`No agents found in ${runtime.packageRoot}/agents`, "info");
					return;
				}
				const lines = names.map((name) => {
					const agent = runtime.agents.get(name);
					const marker = runtime.active?.name === name ? "* " : "  ";
					return `${marker}${name}: ${agent?.description || "(no description)"} [${agent?.path ?? ""}]`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (value === "cycle") return switcher.cycle(ctx);

			if (value === "off" || value === "none" || value === "default") {
				await switcher.deactivate(ctx);
				ctx.ui.notify("Agent cleared, defaults restored", "info");
				return;
			}

			// Unknown name: show what is available and let the user pick.
			if (!runtime.agents.has(value)) {
				const available = switcher.names().join(", ") || "(none discovered)";
				ctx.ui.notify(`Unknown agent "${value}". Available: ${available}`, "warning");
				await switcher.select(ctx);
				return;
			}

			if (await switcher.activate(value, ctx)) {
				ctx.ui.notify(`Agent "${value}" activated`, "info");
			}
		},
	});

	pi.registerCommand("mode", {
		description: "Approval mode: /mode [manual|code|auto]",
		getArgumentCompletions: (prefix) =>
			[...APPROVAL_MODES, "code", ...switcher.names(), "list", "cycle"]
				.filter((name, index, all) => all.indexOf(name) === index)
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const value = args.trim();

			if (!value) return selectMode(ctx);
			if (value === "list") {
				const lines = APPROVAL_MODES.map((mode) => {
					const marker = runtime.mode === mode ? "* " : "  ";
					return `${marker}${mode}: ${approvalModeLabel(mode)}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (value === "cycle") return cycleMode(ctx);

			const mode = normalizeApprovalMode(value);
			if (mode) {
				setMode(mode, ctx);
				ctx.ui.notify(`Approval mode: ${approvalModeLabel(mode)}`, "info");
				return;
			}

			// Compatibility with agent-mode style `/mode <agent>`: an agent name
			// switches the agent instead of failing the approval lookup.
			if (runtime.agents.has(value)) {
				if (await switcher.activate(value, ctx)) {
					ctx.ui.notify(`Agent "${value}" activated`, "info");
				}
				return;
			}

			ctx.ui.notify(
				`Unknown approval mode "${value}". Use: manual, code, auto (or an agent name)`,
				"error",
			);
			await selectMode(ctx);
		},
	});

	pi.registerCommand("plan", {
		description: "Activate the planner agent",
		handler: async (_args, ctx) => {
			if (await switcher.activate("planner", ctx)) {
				ctx.ui.notify("Planner active. Describe what to plan; the plan goes to .pi/plans.", "info");
			}
		},
	});

	pi.registerCommand("run", {
		description: "Activate the worker on the active plan",
		handler: async (_args, ctx) => runActivePlan(ctx),
	});

	registerPlanTools(pi, runtime, {
		onPlanReady: () => {
			runtime.planPending = true;
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		switcher.refresh(ctx);
		const config = applyConfig(ctx);

		const modeFlag = pi.getFlag("approval-mode");
		if (typeof modeFlag === "string" && modeFlag) {
			setModeByName(modeFlag, ctx, false);
		} else {
			const saved = ctx.sessionManager
				.getEntries()
				.slice()
				.reverse()
				.find((entry) => entry.type === "custom" && entry.customType === APPROVAL_ENTRY) as
				| { data?: { mode?: string } }
				| undefined;
			const mode = normalizeApprovalMode(saved?.data?.mode) ?? config.mode;
			if (mode) setMode(mode, ctx, false);
		}
		updateModeStatus(ctx);

		// A pi-subagents child already runs a fixed agent definition; only the
		// approval gate applies there.
		if (isSubagentChild()) return;

		const agentFlag = pi.getFlag("agent");
		if (typeof agentFlag === "string" && agentFlag) {
			await switcher.activate(agentFlag, ctx);
			return;
		}
		await switcher.restore(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (isSubagentChild()) return;
		const sections = [
			event.systemPromptOptions.appendSystemPrompt,
			switcher.promptSection(),
			approvalPromptSection(runtime.mode),
		].filter((section): section is string => Boolean(section));
		event.systemPromptOptions.appendSystemPrompt = sections.join("\n\n");
	});

	pi.on("tool_call", async (event, ctx) =>
		gateToolCall(event, ctx, {
			runtime,
			planGuard: (toolName, input) => planGuard(ctx.cwd, toolName, input),
			isSubagentChild,
		}),
	);

	pi.on("agent_end", async (_event, ctx) => {
		if (!runtime.planPending || !ctx.hasUI) return;
		runtime.planPending = false;

		const file = activePlanFile(ctx.cwd);
		if (!file) return;

		const choice = await ctx.ui.select(`Plan ${basename(file)}`, [
			"Run it (worker)",
			"I will edit it by hand",
			"Discard",
		]);
		if (choice === "Run it (worker)") await runActivePlan(ctx);
		else if (choice === "Discard") {
			discardPlan(file);
			ctx.ui.notify(`Discarded ${file}`, "info");
		} else ctx.ui.notify(`Edit ${file}, then /run`, "info");
	});

	// Optional judge-driven compaction at a subtask boundary.
	pi.on("turn_end", async (_event, ctx) => {
		if (!judgeEnabled()) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		const tokens = usage.tokens;
		if (tokens === null || tokens / usage.contextWindow < 0.6) return;

		const file = activePlanFile(ctx.cwd);
		const verdict = await judge(
			{ usage: tokens / usage.contextWindow, plan: readPlanText(file) },
			"breakpoint",
			"Has a subtask just been completed, so older context can be summarized?",
			"yes",
			"no",
			ctx.signal,
		);
		if (verdict.ok && verdict.p > 0.7) {
			ctx.compact({
				customInstructions:
					"Keep the active plan state, the decisions taken, and the files touched.",
			});
		}
	});
}

/** Read a plan file for the compaction heuristic, tolerating races. */
function readPlanText(file: string | undefined): string {
	if (!file) return "";
	try {
		return readFileSync(file, "utf-8").slice(0, 2000);
	} catch {
		return "";
	}
}
