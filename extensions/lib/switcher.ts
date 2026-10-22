import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agent-files.ts";
import {
	ENTRY_AGENT,
	THINKING_LEVELS,
	type AgentDefinition,
	type Runtime,
	type ThinkingLevel,
} from "./types.ts";

/** Parse `provider/id[:thinking]` model specs against the session registry. */
export function resolveModel(
	spec: string | undefined,
	provider: string | undefined,
	ctx: ExtensionContext,
): { model?: Model<Api>; thinking?: ThinkingLevel } {
	if (!spec) return {};

	let value = spec.trim();
	let thinking: ThinkingLevel | undefined;

	const colon = value.lastIndexOf(":");
	if (colon > 0) {
		const suffix = value.slice(colon + 1) as ThinkingLevel;
		if (THINKING_LEVELS.includes(suffix)) {
			thinking = suffix;
			value = value.slice(0, colon);
		}
	}

	const find = (candidate: string): Model<Api> | undefined => {
		const lookup = candidate.startsWith("~") ? candidate.slice(1) : candidate;
		if (provider) {
			const direct = ctx.modelRegistry.find(provider, lookup);
			if (direct) return direct;
		}
		const slash = lookup.indexOf("/");
		if (slash > 0) {
			const direct = ctx.modelRegistry.find(lookup.slice(0, slash), lookup.slice(slash + 1));
			if (direct) return direct;
		}
		return ctx.modelRegistry
			.getAll()
			.find((model) => `${model.provider}/${model.id}` === lookup || model.id === lookup);
	};

	return { model: find(value), thinking };
}

export interface AgentSwitcher {
	/** Re-read agent markdown files (called on every session start). */
	refresh(ctx: ExtensionContext): void;
	/** Activate an agent as the main-session mode. */
	activate(name: string, ctx: ExtensionContext, persist?: boolean): Promise<boolean>;
	/** Restore the pre-activation tools/model/thinking. */
	deactivate(ctx: ExtensionContext, persist?: boolean): Promise<void>;
	/** Interactive selector, or a list when the UI has none. */
	select(ctx: ExtensionContext): Promise<void>;
	/** Cycle through agents, then `off`. */
	cycle(ctx: ExtensionContext): Promise<void>;
	/** System-prompt section for the active agent. */
	promptSection(): string | undefined;
	/** Restore the last agent persisted in this session. */
	restore(ctx: ExtensionContext): Promise<void>;
	/** Persist the active mode in the footer. */
	updateStatus(ctx: ExtensionContext): void;
	names(): string[];
}

export function createAgentSwitcher(pi: ExtensionAPI, runtime: Runtime): AgentSwitcher {
	/** Configured order first, then any other discovered agent alphabetically. */
	const names = (): string[] => {
		const available = new Set(runtime.agents.keys());
		const ordered: string[] = [];
		for (const name of runtime.agentOrder) {
			if (available.has(name) && !ordered.includes(name)) ordered.push(name);
		}
		const rest = [...available].filter((name) => !ordered.includes(name)).sort();
		return [...ordered, ...rest];
	};

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"agent",
			runtime.active ? ctx.ui.theme.fg("accent", `agent:${runtime.active.name}`) : undefined,
		);
	}

	async function apply(agent: AgentDefinition, ctx: ExtensionContext, persist: boolean): Promise<void> {
		if (!runtime.baseline) {
			runtime.baseline = {
				tools: pi.getActiveTools(),
				model: ctx.model,
				thinking: pi.getThinkingLevel(),
			};
		}
		runtime.active = agent;

		if (agent.tools.length > 0) {
			const all = new Set(pi.getAllTools().map((tool) => tool.name));
			const valid = agent.tools.filter((tool) => all.has(tool));
			const missing = agent.tools.filter((tool) => !all.has(tool));
			if (missing.length > 0) {
				ctx.ui.notify(`Agent "${agent.name}": unavailable tools: ${missing.join(", ")}`, "warning");
			}
			// Never activate an empty set: the agent would lose every tool.
			if (valid.length > 0) pi.setActiveTools(valid);
		}

		const resolved = resolveModel(agent.model, agent.provider, ctx);
		if (resolved.model) {
			const ok = await pi.setModel(resolved.model);
			if (!ok) {
				ctx.ui.notify(
					`Agent "${agent.name}": no credentials for ${resolved.model.provider}/${resolved.model.id}`,
					"warning",
				);
			}
		} else if (agent.model) {
			ctx.ui.notify(`Agent "${agent.name}": model "${agent.model}" not found`, "warning");
		}

		const thinking = resolved.thinking ?? agent.thinking;
		if (thinking) pi.setThinkingLevel(thinking);

		if (persist) pi.appendEntry(ENTRY_AGENT, { name: agent.name });
		updateStatus(ctx);
	}

	async function deactivate(ctx: ExtensionContext, persist = true): Promise<void> {
		const baseline = runtime.baseline;
		if (baseline) {
			pi.setActiveTools(baseline.tools);
			pi.setThinkingLevel(baseline.thinking);
			if (baseline.model) await pi.setModel(baseline.model);
			runtime.baseline = undefined;
		}
		runtime.active = undefined;
		if (persist) pi.appendEntry(ENTRY_AGENT, { name: "off" });
		updateStatus(ctx);
	}

	async function activate(name: string, ctx: ExtensionContext, persist = true): Promise<boolean> {
		const agent = runtime.agents.get(name);
		if (!agent) {
			const available = names().join(", ") || "(none discovered)";
			ctx.ui.notify(`Unknown agent "${name}". Available: ${available}`, "error");
			return false;
		}
		await apply(agent, ctx, persist);
		return true;
	}

	async function select(ctx: ExtensionContext): Promise<void> {
		const available = names();
		if (available.length === 0) {
			ctx.ui.notify(`No agents found in ${runtime.packageRoot}/agents`, "warning");
			return;
		}

		const labels = [
			"(off) restore defaults",
			...available.map((name) => {
				const agent = runtime.agents.get(name);
				const suffix = runtime.active?.name === name ? " (active)" : "";
				return `${name}${suffix} — ${agent?.description || "no description"}`;
			}),
		];

		const choice = await ctx.ui.select("Agent", labels);
		if (!choice) return;
		if (choice.startsWith("(off)")) {
			await deactivate(ctx);
			ctx.ui.notify("Agent cleared, defaults restored", "info");
			return;
		}
		const name = choice.split(" — ")[0]?.replace(" (active)", "").trim() ?? "";
		if (await activate(name, ctx)) ctx.ui.notify(`Agent "${name}" activated`, "info");
	}

	async function cycle(ctx: ExtensionContext): Promise<void> {
		const available = names();
		if (available.length === 0) {
			ctx.ui.notify("No agents discovered", "warning");
			return;
		}
		const ring = ["(off)", ...available];
		const current = runtime.active?.name ?? "(off)";
		const next = ring[(ring.indexOf(current) + 1) % ring.length] ?? "(off)";
		if (next === "(off)") {
			await deactivate(ctx);
			ctx.ui.notify("Agent cleared, defaults restored", "info");
			return;
		}
		if (await activate(next, ctx)) ctx.ui.notify(`Agent "${next}" activated`, "info");
	}

	return {
		refresh(ctx) {
			runtime.agents = discoverAgents(ctx.cwd, {
				packageRoot: runtime.packageRoot,
				trusted: ctx.isProjectTrusted(),
			});
		},
		activate,
		deactivate,
		select,
		cycle,
		names,
		updateStatus,
		promptSection() {
			if (!runtime.active?.body) return undefined;
			return `<agent name="${runtime.active.name}">\n${runtime.active.body}\n</agent>`;
		},
		async restore(ctx) {
			const entry = ctx.sessionManager
				.getEntries()
				.slice()
				.reverse()
				.find((item) => item.type === "custom" && item.customType === ENTRY_AGENT) as
				| { data?: { name?: string } }
				| undefined;

			const saved = entry?.data?.name;
			if (!saved || saved === "off") {
				updateStatus(ctx);
				return;
			}
			const agent = runtime.agents.get(saved);
			if (agent) {
				runtime.active = undefined;
				runtime.baseline = undefined;
				await apply(agent, ctx, false);
			}
		},
	};
}
