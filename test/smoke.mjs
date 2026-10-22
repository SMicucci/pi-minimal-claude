/**
 * Smoke test for pi-minimal-claude.
 *
 * Loads the extension the way Pi does (jiti, TypeScript) with a fake
 * ExtensionAPI/ExtensionContext, then exercises agent switching, approval
 * modes, configurable shortcuts and the plan/debug tools.
 * No network, no Pi session, no real HOME.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "pi-minimal-claude-"));
const fakeHome = join(sandbox, "home");
const workspace = join(sandbox, "workspace");
mkdirSync(fakeHome, { recursive: true });
mkdirSync(workspace, { recursive: true });

// Hermetic discovery: no user agents, no judge server, no inherited config.
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.PI_JUDGE_URL = "off";
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_MODE;
delete process.env.PI_APPROVAL_MODE;
delete process.env.PI_ACTIVE_PLAN;
delete process.env.PI_AGENT_DIRS;
delete process.env.PI_MINIMAL_CLAUDE_SHORTCUTS;
delete process.env.PI_MINIMAL_CLAUDE_AGENT_CYCLE;
delete process.env.PI_MINIMAL_CLAUDE_AGENT_CYCLE_ALT;
delete process.env.PI_MINIMAL_CLAUDE_APPROVAL_CYCLE;

const BASE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"bash",
	"subagent",
	"web_search",
	"fetch_content",
	"dap",
];

let checks = 0;
async function check(label, fn) {
	await fn();
	checks += 1;
	console.log(`  ok  ${label}`);
}

function createHarness(initialSettings = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const flags = new Map();
	const entries = [];
	const notifications = [];
	const statuses = {};
	const confirmations = [];
	const answers = [];
	const sent = [];
	const settings = { value: initialSettings };
	const state = {
		activeTools: [...BASE_TOOLS],
		model: undefined,
		thinking: "medium",
		compacted: false,
		execCalls: [],
	};

	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		registerFlag(name, options) {
			flags.set(name, { ...options });
		},
		getFlag(name) {
			return flags.get(name)?.value;
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return [...state.activeTools];
		},
		setActiveTools(names) {
			state.activeTools = [...names];
		},
		getAllTools() {
			const names = new Set([...BASE_TOOLS, ...tools.keys()]);
			return [...names].map((name) => ({ name }));
		},
		async setModel(model) {
			state.model = model;
			return true;
		},
		getThinkingLevel() {
			return state.thinking;
		},
		setThinkingLevel(level) {
			state.thinking = level;
		},
		async exec(command, args, options) {
			state.execCalls.push({ command, args, options });
			return { stdout: "explorer-answer", stderr: "", code: 0 };
		},
		sendUserMessage(content) {
			sent.push(content);
		},
		getSettings() {
			return settings.value;
		},
	};

	const ctx = {
		cwd: workspace,
		hasUI: true,
		mode: "print",
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
			setStatus: (key, value) => {
				statuses[key] = value;
			},
			theme: { fg: (_color, text) => text },
			select: async (_title, options) => {
				const answer = answers.shift();
				return answer === undefined ? options[0] : answer;
			},
			confirm: async (title, message) => {
				confirmations.push({ title, message });
				return true;
			},
			input: async () => undefined,
		},
		sessionManager: { getEntries: () => entries },
		modelRegistry: { find: () => undefined, getAll: () => [] },
		model: undefined,
		thinkingLevel: "medium",
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
		compact: () => {
			state.compacted = true;
		},
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({}),
		waitForIdle: async () => {},
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
	};

	async function emit(event, payload, target = ctx) {
		const results = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload ?? { type: event }, target));
		}
		return results.filter((result) => result !== undefined);
	}

	const toolCall = async (toolName, input) =>
		(await emit("tool_call", { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input }))[0];

	return {
		pi,
		ctx,
		state,
		settings,
		handlers,
		tools,
		commands,
		shortcuts,
		flags,
		entries,
		notifications,
		statuses,
		confirmations,
		answers,
		sent,
		emit,
		toolCall,
	};
}

function newExtension(harness) {
	const jiti = createJiti(import.meta.url);
	const module = jiti.import(join(pluginRoot, "extensions", "index.ts"));
	return module.then((loaded) => {
		loaded.default(harness.pi);
		return loaded;
	});
}

// ------------------------------------------------------------------ main flow

const h = createHarness();
const jiti = createJiti(import.meta.url);
const extension = await jiti.import(join(pluginRoot, "extensions", "index.ts"));
extension.default(h.pi);

await check("extension factory registers 4 tools", () => {
	assert.deepEqual([...h.tools.keys()].sort(), ["debug_print", "explore", "plan_task", "plan_write"]);
});

await check("extension registers /agent, /mode, /plan, /run", () => {
	assert.deepEqual([...h.commands.keys()].sort(), ["agent", "mode", "plan", "run"]);
});

await check("shortcuts are deferred until session_start", () => {
	assert.equal(h.shortcuts.size, 0);
});

await h.emit("session_start");

await check("session_start registers the default shortcuts", () => {
	assert.deepEqual(
		[...h.shortcuts.keys()].sort(),
		["alt+m", "alt+shift+tab", "ctrl+shift+a"],
	);
	assert.equal(h.statuses.approval, "mode:manual");
});

await check("shift+tab is never registered (reserved by Pi)", () => {
	assert.equal(h.shortcuts.has("shift+tab"), false);
});

await check("default shortcuts avoid Pi's reserved keys", () => {
	// RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS defaults in Pi's runner.
	const reserved = new Set([
		"escape",
		"ctrl+c",
		"ctrl+d",
		"ctrl+z",
		"shift+tab",
		"ctrl+p",
		"shift+ctrl+p",
		"ctrl+l",
		"ctrl+o",
		"ctrl+t",
		"ctrl+g",
		"ctrl+x",
		"alt+enter",
		"enter",
	]);
	for (const key of h.shortcuts.keys()) assert.equal(reserved.has(key), false, `${key} is reserved`);
});

await check("/agent list follows the configured order", async () => {
	await h.commands.get("agent").handler("list", h.ctx);
	const last = h.notifications.at(-1)?.message ?? "";
	const order = ["worker", "planner", "explorer", "debugger"].map((name) => last.indexOf(name));
	assert.ok(order.every((index) => index >= 0));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
});

await check("/agent completions follow the configured order", () => {
	const values = h.commands
		.get("agent")
		.getArgumentCompletions("")
		.map((item) => item.value);
	assert.deepEqual(values.slice(0, 4), ["worker", "planner", "explorer", "debugger"]);
	for (const control of ["list", "off", "cycle"]) assert.ok(values.includes(control));
});

await check("/agent with no name opens the selector", async () => {
	h.answers.push("planner");
	await h.commands.get("agent").handler("", h.ctx);
	assert.equal(h.statuses.agent, "agent:planner");
});

await check("/agent with a wrong name lists agents and opens the selector", async () => {
	h.answers.push("worker");
	await h.commands.get("agent").handler("bogus", h.ctx);
	const warning = h.notifications.find(
		(entry) => entry.type === "warning" && /Unknown agent "bogus"/.test(entry.message),
	);
	assert.ok(warning, "expected an unknown-agent warning");
	assert.match(warning.message, /worker, planner, explorer, debugger/);
	assert.equal(h.statuses.agent, "agent:worker");
});

await check("agent rotation shortcut follows worker → planner → explorer → debugger → off", async () => {
	const handler = h.shortcuts.get("alt+shift+tab").handler;
	assert.equal(h.statuses.agent, "agent:worker");
	await handler(h.ctx);
	assert.equal(h.statuses.agent, "agent:planner");
	await handler(h.ctx);
	assert.equal(h.statuses.agent, "agent:explorer");
	await handler(h.ctx);
	assert.equal(h.statuses.agent, "agent:debugger");
	await handler(h.ctx);
	assert.equal(h.statuses.agent, undefined);
});

await check("/plan activates the planner", async () => {
	await h.commands.get("plan").handler("", h.ctx);
	assert.equal(h.statuses.agent, "agent:planner");
	assert.deepEqual(
		[...h.state.activeTools].sort(),
		["explore", "find", "grep", "ls", "plan_write", "read"].sort(),
	);
});

await h.commands.get("agent").handler("explorer", h.ctx);

await check("/agent explorer activates only explorer tools", () => {
	assert.deepEqual(
		[...h.state.activeTools].sort(),
		["fetch_content", "find", "grep", "ls", "read", "subagent", "web_search"],
	);
	assert.equal(h.statuses.agent, "agent:explorer");
});

await check("before_agent_start appends agent + approval sections", async () => {
	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt: "hi",
		systemPrompt: "base",
		systemPromptOptions: { appendSystemPrompt: "BASE" },
	};
	await h.emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.appendSystemPrompt, /BASE/);
	assert.match(event.systemPromptOptions.appendSystemPrompt, /<agent name="explorer">/);
	assert.match(event.systemPromptOptions.appendSystemPrompt, /<approval-mode name="manual">/);
});

await check("manual mode asks before an in-workspace edit", async () => {
	h.confirmations.length = 0;
	assert.equal(await h.toolCall("edit", { path: "src/app.ts" }), undefined);
	assert.equal(h.confirmations.length, 1);
});

await check("manual mode blocks a non-read call without a UI", async () => {
	const noUi = { ...h.ctx, hasUI: false };
	const result = (
		await h.emit(
			"tool_call",
			{ type: "tool_call", toolCallId: "call-bash", toolName: "bash", input: { command: "rm -rf src" } },
			noUi,
		)
	)[0];
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /needs approval/);
});

await check("/mode code is accepted as code-only", async () => {
	await h.commands.get("mode").handler("code", h.ctx);
	assert.equal(h.statuses.approval, "mode:code-only");
});

await check("/mode completions offer manual, code, auto", () => {
	const values = h.commands
		.get("mode")
		.getArgumentCompletions("")
		.map((item) => item.value);
	for (const value of ["manual", "code", "auto", "code-only", "cycle"]) {
		assert.ok(values.includes(value), `missing completion ${value}`);
	}
});

await check("code-only auto-approves in-workspace edits", async () => {
	h.confirmations.length = 0;
	assert.equal(await h.toolCall("edit", { path: "src/app.ts" }), undefined);
	assert.equal(h.confirmations.length, 0);
});

await check("code-only still asks for writes outside the workspace", async () => {
	h.confirmations.length = 0;
	assert.equal(await h.toolCall("write", { path: "../escape.ts" }), undefined);
	assert.equal(h.confirmations.length, 1);
});

await check("code-only still asks for bash", async () => {
	h.confirmations.length = 0;
	await h.toolCall("bash", { command: "npm test" });
	assert.equal(h.confirmations.length, 1);
});

await check("approval shortcut rotates manual → code-only → auto", async () => {
	await h.commands.get("mode").handler("manual", h.ctx);
	const handler = h.shortcuts.get("alt+m").handler;
	await handler(h.ctx);
	assert.equal(h.statuses.approval, "mode:code-only");
	await handler(h.ctx);
	assert.equal(h.statuses.approval, "mode:auto");
	await handler(h.ctx);
	assert.equal(h.statuses.approval, "mode:manual");
});

await check("legacy aliases map onto canonical modes", async () => {
	await h.commands.get("mode").handler("full-auto", h.ctx);
	assert.equal(h.statuses.approval, "mode:auto");
	await h.commands.get("mode").handler("auto-write", h.ctx);
	assert.equal(h.statuses.approval, "mode:code-only");
});

await check("/mode with a wrong value lists modes and opens the selector", async () => {
	h.notifications.length = 0;
	h.answers.push("manual");
	await h.commands.get("mode").handler("bogus", h.ctx);
	const error = h.notifications.find((entry) => entry.type === "error");
	assert.ok(error, "expected an error notification");
	assert.match(error.message, /manual, code, auto/);
	assert.equal(h.statuses.approval, "mode:manual");
});

await h.commands.get("mode").handler("manual", h.ctx);

await check("plan_write creates and activates a plan", async () => {
	const result = await h.tools.get("plan_write").execute(
		"call-plan",
		{ name: "smoke plan", content: "---\nstatus: draft\n---\n# Plan\n- [ ] T1: first\n- [ ] T2: second\n" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(result.content[0].text, /Waiting for user approval/);
	const file = join(workspace, ".pi", "plans", "smoke_plan.md");
	assert.match(readFileSync(file, "utf-8"), /status: active/);
});

await check("plan_task lists tasks and ticks one", async () => {
	const listing = await h.tools.get("plan_task").execute("call-list", {}, undefined, undefined, h.ctx);
	assert.match(listing.content[0].text, /0\. \[ \] T1: first/);
	await h.tools.get("plan_task").execute("call-done", { id: 0, done: true }, undefined, undefined, h.ctx);
	const file = join(workspace, ".pi", "plans", "smoke_plan.md");
	assert.match(readFileSync(file, "utf-8"), /- \[x\] T1: first/);
});

await check("planner hand-off: agent_end offers the worker", async () => {
	await h.emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(h.statuses.agent, "agent:worker");
	assert.match(String(h.sent.at(-1)), /Execute the active plan \(smoke_plan\.md\)/);
});

await check("plan files are read-only through edit/bash", async () => {
	const viaEdit = await h.toolCall("edit", { path: ".pi/plans/smoke_plan.md" });
	assert.equal(viaEdit?.block, true);
	const viaBash = await h.toolCall("bash", { command: "sed -i s/a/b/ .pi/plans/smoke_plan.md" });
	assert.equal(viaBash?.block, true);
});

await check("debug_print inserts one marked line and removes it again", async () => {
	const file = join(workspace, "app.ts");
	writeFileSync(file, "const a = 1;\nconst b = 2;\n");
	await h.tools
		.get("debug_print")
		.execute("call-insert", { path: "app.ts", line: 1, code: "console.log(a);" }, undefined, undefined, h.ctx);
	const inserted = readFileSync(file, "utf-8").split("\n");
	assert.match(inserted[1], /console\.log\(a\); \/\/ DBG:/);
	await h.tools.get("debug_print").execute("call-remove", { path: "app.ts", remove: true }, undefined, undefined, h.ctx);
	assert.equal(readFileSync(file, "utf-8"), "const a = 1;\nconst b = 2;\n");
});

await check("explore delegates to a read-only child session", async () => {
	const result = await h.tools.get("explore").execute("call-explore", { question: "where?" }, undefined, undefined, h.ctx);
	assert.match(result.content[0].text, /explorer-answer/);
	const call = h.state.execCalls.at(-1);
	assert.ok(call.args.includes("--no-session"));
	assert.ok(call.args.includes("--append-system-prompt"));
	assert.ok(!(call.args[call.args.indexOf("--tools") + 1] ?? "").includes("subagent"));
});

await h.commands.get("agent").handler("off", h.ctx);

await check("/agent off restores the baseline tool set", () => {
	assert.deepEqual([...h.state.activeTools].sort(), [...BASE_TOOLS].sort());
	assert.equal(h.statuses.agent, undefined);
});

await check("/run activates the worker and prompts it with the active plan", async () => {
	await h.commands.get("run").handler("", h.ctx);
	assert.equal(h.statuses.agent, "agent:worker");
	assert.match(String(h.sent.at(-1)), /Execute the active plan \(smoke_plan\.md\)/);
	assert.ok(existsSync(join(workspace, ".pi", "plans", "smoke_plan.md")));
});

await check("agent and approval choices persist as session entries", () => {
	const agentEntry = h.entries.filter((entry) => entry.customType === "minimal-claude/agent").at(-1);
	const approvalEntry = h.entries.filter((entry) => entry.customType === "minimal-claude/approval").at(-1);
	assert.equal(agentEntry?.data?.name, "worker");
	assert.equal(approvalEntry?.data?.mode, "manual");
});

// ------------------------------------------------------- configured shortcuts

const h2 = createHarness({
	minimalClaude: {
		shortcuts: { agentCycle: "ctrl+shift+g", agentCycleAlt: "off", approvalCycle: "ctrl+shift+k" },
		agentOrder: ["debugger", "worker"],
		mode: "code",
	},
});
await newExtension(h2);
await h2.emit("session_start");

await check("settings rebind the shortcuts", () => {
	assert.deepEqual([...h2.shortcuts.keys()].sort(), ["ctrl+shift+g", "ctrl+shift+k"]);
});

await check("settings mode is used when nothing else is configured", () => {
	assert.equal(h2.statuses.approval, "mode:code-only");
});

await check("settings agentOrder drives list order and rotation", async () => {
	await h2.commands.get("agent").handler("list", h2.ctx);
	const last = h2.notifications.at(-1)?.message ?? "";
	assert.ok(last.indexOf("debugger") < last.indexOf("worker"));
	assert.ok(last.indexOf("worker") < last.indexOf("explorer"));

	await h2.shortcuts.get("ctrl+shift+g").handler(h2.ctx);
	assert.equal(h2.statuses.agent, "agent:debugger");
	await h2.shortcuts.get("ctrl+shift+g").handler(h2.ctx);
	assert.equal(h2.statuses.agent, "agent:worker");
});

const h3 = createHarness({ minimalClaude: { shortcuts: { agentCycle: "not a key" } } });
await newExtension(h3);
await h3.emit("session_start");

await check("an invalid shortcut falls back to the default and warns", () => {
	assert.ok(h3.shortcuts.has("alt+shift+tab"));
	assert.ok(
		h3.notifications.some(
			(entry) => entry.type === "warning" && /invalid key "not a key"/.test(entry.message),
		),
	);
});

process.env.PI_MINIMAL_CLAUDE_AGENT_CYCLE = "ctrl+shift+y";
const h4 = createHarness({ minimalClaude: { shortcuts: { agentCycle: "ctrl+shift+g" } } });
await newExtension(h4);
await h4.emit("session_start");

await check("environment overrides settings", () => {
	assert.ok(h4.shortcuts.has("ctrl+shift+y"));
	assert.equal(h4.shortcuts.has("ctrl+shift+g"), false);
});
delete process.env.PI_MINIMAL_CLAUDE_AGENT_CYCLE;

process.env.PI_MINIMAL_CLAUDE_SHORTCUTS = "off";
const h5 = createHarness();
await newExtension(h5);
await h5.emit("session_start");
delete process.env.PI_MINIMAL_CLAUDE_SHORTCUTS;

await check("PI_MINIMAL_CLAUDE_SHORTCUTS=off registers no shortcuts", () => {
	assert.equal(h5.shortcuts.size, 0);
	assert.equal(h5.statuses.agent, undefined);
});

rmSync(sandbox, { recursive: true, force: true });
console.log(`\nsmoke: ${checks} checks passed`);
