import type { Api, Model } from "@earendil-works/pi-ai";

/** Thinking levels understood by Pi, in ascending effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Approval (completion) modes exposed to the user. */
export const APPROVAL_MODES = ["manual", "code-only", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Default shortcut for cycling agents. `shift+tab` is reserved by Pi. */
export const DEFAULT_AGENT_CYCLE = "alt+shift+tab";
/** Secondary agent-cycle shortcut, free of built-in conflicts. */
export const DEFAULT_AGENT_CYCLE_ALT = "ctrl+shift+a";
/** Default shortcut for cycling approval modes. */
export const DEFAULT_APPROVAL_CYCLE = "alt+m";
/** Default agent rotation/completion order. */
export const DEFAULT_AGENT_ORDER = ["worker", "planner", "explorer", "debugger"];

/** One parsed agent definition, loaded from an agent markdown file. */
export interface AgentDefinition {
	/** Runtime name, from frontmatter `name` or the file basename. */
	name: string;
	description: string;
	/** Tools activated when the agent becomes the main-session mode. */
	tools: string[];
	/** Optional `provider/id[:thinking]` model spec. */
	model?: string;
	/** Optional provider override for a bare model id. */
	provider?: string;
	thinking?: ThinkingLevel;
	/** Markdown body, appended to the system prompt while the agent is active. */
	body: string;
	path: string;
}

/** Session state captured before the first agent activation, restored by `/agent off`. */
export interface Baseline {
	tools: string[];
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
}

/** Mutable plugin state shared by the extension modules. */
export interface Runtime {
	/** Absolute path of the package root (the directory that holds `agents/`). */
	packageRoot: string;
	/** Discovered agents, keyed by runtime name. */
	agents: Map<string, AgentDefinition>;
	/** Active main-session agent, if any. */
	active?: AgentDefinition;
	/** Pre-activation tools/model/thinking, restored when the agent is cleared. */
	baseline?: Baseline;
	/** Active approval mode. */
	mode: ApprovalMode;
	/** Agent rotation/completion order; unknown names are skipped at runtime. */
	agentOrder: string[];
	/** True when the planner wrote a plan that still waits for user approval. */
	planPending: boolean;
}

/** Custom session entry types used for persistence across resume/branch. */
export const ENTRY_AGENT = "minimal-claude/agent";
export const ENTRY_APPROVAL = "minimal-claude/approval";
