import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { judge } from "./judge.ts";
import type { Runtime } from "./types.ts";

/** Plan files live under the project config dir and are written only by tools. */
export const PLANS_DIR = join(".pi", "plans");

const TASK_LINE = /^(\s*[-*] )\[( |x)\] (.*)$/;
const FILE_WRITES = new Set(["edit", "write", "debug_print"]);

function isInside(root: string, target: string): boolean {
	const base = resolve(root);
	const full = resolve(target);
	return full === base || full.startsWith(base + sep);
}

/** Block direct mutations of plan files; plan_write/plan_task are the API. */
export function planGuard(
	cwd: string,
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	const plansRoot = resolve(cwd, PLANS_DIR);

	if (FILE_WRITES.has(toolName) && typeof input.path === "string") {
		if (isInside(plansRoot, resolve(cwd, input.path))) {
			return "Plan files are read-only: use plan_write (planner) or plan_task (worker).";
		}
	}

	if (toolName === "bash" && /\.pi[\\/]plans/.test(String(input.command ?? ""))) {
		return "Plan files are not reachable through bash; use plan_write / plan_task.";
	}

	return undefined;
}

/** The active plan: `PI_ACTIVE_PLAN`, else the file marked `status: active`, else newest. */
export function activePlanFile(cwd: string): string | undefined {
	const fromEnv = process.env.PI_ACTIVE_PLAN;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	const dir = join(cwd, PLANS_DIR);
	if (!existsSync(dir)) return undefined;

	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => join(dir, name));
	if (files.length === 0) return undefined;

	const active = files.find((file) =>
		/^---[\s\S]*?status:\s*active[\s\S]*?---/.test(readFileSync(file, "utf-8")),
	);
	return active ?? files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function text(message: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: message }], details };
}

/** Reuse the running CLI to spawn a fresh, read-only child session. */
function childCli(): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script) && /\.(?:[cm]?[jt]s)$/i.test(script)) {
		return { command: process.execPath, args: [script] };
	}
	return { command: process.execPath, args: [] };
}

export interface PlanHooks {
	/** Called when the planner left a plan waiting for user approval. */
	onPlanReady?: (file: string) => void;
}

export function registerPlanTools(pi: ExtensionAPI, runtime: Runtime, hooks: PlanHooks = {}): void {
	pi.registerTool({
		name: "plan_write",
		label: "Plan write",
		description:
			"Write the plan to .pi/plans/<name>.md, make it the active plan, and deactivate the previous one. Tasks use `- [ ] T1: <step>`.",
		parameters: Type.Object({
			name: Type.String({ description: "File slug, for example `auth-refactor`." }),
			content: Type.String({ description: "Plan markdown: title, context, then task lines." }),
		}),
		async execute(_id, { name, content }, _signal, _onUpdate, ctx) {
			const dir = join(ctx.cwd, PLANS_DIR);
			mkdirSync(dir, { recursive: true });

			for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
				const full = join(dir, file);
				writeFileSync(full, readFileSync(full, "utf-8").replace(/status:\s*active/, "status: inactive"));
			}

			const safe = name.trim().replace(/[^\w-]/g, "_") || "plan";
			const file = join(dir, `${safe}.md`);
			const body = content.replace(/^---[\s\S]*?---\r?\n/, "");
			writeFileSync(file, `---\nstatus: active\n---\n${body}`);
			process.env.PI_ACTIVE_PLAN = file;
			runtime.planPending = ctx.hasUI;
			hooks.onPlanReady?.(file);

			if (ctx.hasUI) {
				return text(`Plan written: ${file}. Waiting for user approval.`, { file });
			}

			const verdict = await judge(
				{ plan: content.slice(0, 3000) },
				"plan_ok",
				"Is this plan complete, ordered and actionable?",
				"yes",
				"no",
			);
			if (!verdict.ok || verdict.p >= 0.7) return text(`APPROVED ${file}`, { file });
			return text(`REJECTED (p=${verdict.p.toFixed(2)}): revise the plan`, { file });
		},
	});

	pi.registerTool({
		name: "plan_task",
		label: "Plan task",
		description:
			"Without id: list the active plan tasks. With id: mark it (done=true|false) and optionally verify the evidence.",
		parameters: Type.Object({
			id: Type.Optional(Type.Number({ description: "Task index from the listing." })),
			done: Type.Optional(Type.Boolean({ description: "true marks done, false reopens." })),
			evidence: Type.Optional(Type.String({ description: "Test output or diff proving the task is done." })),
		}),
		async execute(_id, { id, done, evidence }, _signal, _onUpdate, ctx) {
			const file = activePlanFile(ctx.cwd);
			if (!file) return text("No active plan.");

			const source = readFileSync(file, "utf-8");
			const eol = source.includes("\r\n") ? "\r\n" : "\n";
			const lines = source.split(/\r?\n/);
			const tasks = lines.flatMap((line, index) => {
				const match = line.match(TASK_LINE);
				return match ? [{ index, match }] : [];
			});

			if (id === undefined) {
				const listing = tasks.map((task, index) => `${index}. [${task.match[2]}] ${task.match[3]}`);
				return text(`${file}\n${listing.join("\n")}`, { file });
			}

			const task = tasks[id];
			if (!task) throw new Error(`Task ${id} does not exist`);
			const title = task.match[3] ?? "";

			if (done !== false && evidence) {
				const verdict = await judge(
					{ task: title, evidence: evidence.slice(0, 2000) },
					"done",
					"Does the evidence show the task is completed?",
					"yes",
					"no",
				);
				if (verdict.ok && verdict.p < 0.8) {
					throw new Error(
						`Not verified (p=${verdict.p.toFixed(2)}): add evidence or finish the task first`,
					);
				}
			}

			lines[task.index] = `${task.match[1]}[${done === false ? " " : "x"}] ${title}`;
			writeFileSync(file, lines.join(eol));
			return text(`Task ${id} -> ${done === false ? "todo" : "done"}`, { file, id });
		},
	});

	pi.registerTool({
		name: "explore",
		label: "Explore",
		description: "Ask a read-only explorer subagent about the codebase or the web. Returns only the final answer.",
		parameters: Type.Object({ question: Type.String({ description: "What to find out." }) }),
		async execute(_id, { question }, signal, _onUpdate, ctx) {
			const explorer = runtime.agents.get("explorer");
			if (!explorer) throw new Error("No explorer agent found in the agents directory");

			const tools = explorer.tools.filter((tool) => tool !== "subagent").join(",");
			const { command, args } = childCli();
			const result = await pi.exec(
				command,
				[
					...args,
					"-p",
					"--no-session",
					...(tools ? ["--tools", tools] : []),
					"--append-system-prompt",
					explorer.body,
					question,
				],
				{ signal, cwd: ctx.cwd },
			);

			const output = result.stdout.trim() || result.stderr.trim();
			return text(output.slice(-8000), { exitCode: result.code });
		},
	});

	pi.registerTool({
		name: "debug_print",
		label: "Debug print",
		description:
			"Insert one marked DBG line after `line`, or with remove=true strip every DBG line from the file.",
		parameters: Type.Object({
			path: Type.String({ description: "File to probe." }),
			line: Type.Optional(Type.Number({ description: "Insert after this 1-based line." })),
			code: Type.Optional(Type.String({ description: "One-line print statement." })),
			remove: Type.Optional(Type.Boolean({ description: "Remove every DBG line instead of inserting." })),
		}),
		async execute(_id, { path, line, code, remove }, _signal, _onUpdate, ctx) {
			const file = resolve(ctx.cwd, path);
			const source = readFileSync(file, "utf-8");
			const eol = source.includes("\r\n") ? "\r\n" : "\n";
			const lines = source.split(/\r?\n/);

			if (remove) {
				const kept = lines.filter((entry) => !entry.includes("DBG:"));
				writeFileSync(file, kept.join(eol));
				return text(`Removed ${lines.length - kept.length} DBG line(s)`, { file });
			}

			if (!line || !code || code.includes("\n")) {
				throw new Error("`line` and a single-line `code` are required when remove is not set");
			}

			const comment = [".py", ".sh", ".rb", ".yaml", ".yml", ".toml"].includes(extname(file)) ? "#" : "//";
			const indent = lines[line - 1]?.match(/^\s*/)?.[0] ?? "";
			lines.splice(line, 0, `${indent}${code} ${comment} DBG:${Date.now().toString(36)}`);
			writeFileSync(file, lines.join(eol));
			return text(`Inserted after line ${line}`, { file });
		},
	});
}

/** Remove a plan file and forget the active-plan pointer. */
export function discardPlan(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Already gone.
	}
	if (process.env.PI_ACTIVE_PLAN === file) delete process.env.PI_ACTIVE_PLAN;
}
