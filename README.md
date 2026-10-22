# pi-minimal-claude

[![npm](https://img.shields.io/npm/v/pi-minimal-claude.svg)](https://www.npmjs.com/package/pi-minimal-claude)
[![license](https://img.shields.io/npm/l/pi-minimal-claude.svg)](LICENSE)

A Pi package that ships four agent definitions **in the package root** and keeps
every command, tool and approval rule **inside the extension**.

```
pi-minimal-claude/
├── agents/                # visible, editable agent definitions
│   ├── planner.md
│   ├── worker.md
│   ├── explorer.md
│   └── debugger.md
├── extensions/
│   ├── index.ts           # commands, shortcuts, flags, events
│   └── lib/
│       ├── agent-files.ts # discovery + frontmatter parsing
│       ├── approval.ts    # manual | code-only | auto gate
│       ├── config.ts      # settings/env parsing for shortcuts and order
│       ├── judge.ts       # optional local judge client
│       ├── plan.ts        # plan_write / plan_task / explore / debug_print
│       ├── switcher.ts    # agent activation (tools, model, thinking, prompt)
│       └── types.ts
├── test/                  # smoke + loader parity checks
└── package.json           # pi manifest: extensions + subagents.agents
```

The same `agents/*.md` files are consumed twice:

- by **pi-subagents** (declared through `pi.subagents.agents`), so
  `subagent({ agent: "planner" })` sees them;
- by this extension, which uses them as switchable **main-session modes**
  (active tools, optional model, optional thinking level, prompt section).

## Install

From npm:

```bash
pi install npm:pi-minimal-claude@0.1.0
```

From git (tags are pinned):

```bash
pi install git:github.com/SMicucci/pi-minimal-claude@v0.1.0
```

From a checkout:

```bash
# personal install, or `pi install -l ./` for the project scope
pi install ./

# or for a single run
pi -e ./
```

Do not stack two sources: npm/git installs and the local
`"packages": [".."]` entry in `.pi/settings.json` are different package
identities, so Pi loads the extension twice and refuses the duplicate tools and
flags. When you install from npm or git, drop the local entry from
`.pi/settings.json`.

Project-scoped install: `.pi/settings.json`

```json
{
  "packages": [".."],
  "subagents": { "agentScanDirs": ["./agents"] }
}
```

`packages: [".."]` resolves from `.pi/`, so it points at this package root.
`agentScanDirs` is optional and resolves against the working directory: it is
useful when Pi runs from another directory, for example when the package is
linked but not declared. Pi loads project packages only after project trust is
granted; pass `-a` to trust the project for one command:

```bash
pi -a -p --no-session --agent explorer "where is the approval gate?"
```

## Agents

| Agent | Use it for | Tools |
|---|---|---|
| `planner` | plan, never write code | `read, grep, find, ls, plan_write, explore` |
| `worker` | execute the active plan, write code, delegate | `read, grep, find, ls, edit, write, bash, subagent, plan_task` |
| `explorer` | research codebase/web, writes nothing | `read, grep, find, ls, web_search, fetch_content, subagent` |
| `debugger` | reproduce bugs with DAP or print debugging | `read, grep, find, ls, bash, debug_print, subagent, dap` |

An agent markdown file uses the pi-subagents format:

```yaml
---
name: reviewer
description: Read-only diff review
tools: read, grep, find, ls
model: openrouter/anthropic/claude-sonnet-4   # optional, supports :thinking suffix
thinking: medium                              # optional
---
Your prompt here. It is appended to the system prompt while the agent is active.
```

Discovery roots, lowest priority first — a later root wins on a name clash:

1. `<packageRoot>/agents` (defaults shipped here)
2. `~/.pi/agent/agents` (user)
3. `<cwd>/.agents` and `<cwd>/.pi/agents` (project, only when trusted)
4. `PI_AGENT_DIRS` (path-delimiter separated, highest)

So a project can override `worker.md` without touching the package.

Changing the agent **does not restart the session**: it swaps the active tool
set, applies the optional model/thinking, updates the footer and appends the
agent body to the system prompt. `/agent off` restores the tools, model and
thinking level captured before the first activation.

## Approval modes

| Mode | Behaviour |
|---|---|
| `manual` | every non-read call asks for confirmation |
| `code-only` | `edit`/`write`/`debug_print` inside the workspace run without asking; shell, network and outside paths still ask |
| `auto` | local writes run without asking; anything else is sent to the judge (if configured) and only auto-approved when the risk is low, otherwise confirmed |

Legacy aliases are accepted: `auto-write` → `code-only`, `full-auto` → `auto`.

Rules that always apply:

- reads, `plan_write`, `plan_task`, `explore`, `subagent`, `web_search`,
  `fetch_content` never ask;
- `.pi/plans` is read-only: `edit`/`write`/`debug_print` are blocked there and
  `bash` commands that mention `.pi/plans` are blocked;
- without a UI (print mode, delegated child) `manual` blocks instead of asking.
  A pi-subagents child runs at most `code-only`, because its parent already
  approved the delegation;
- the mode is exported as `PI_APPROVAL_MODE` (and legacy `PI_MODE`), so child
  processes inherit it.

### Optional judge

`auto` uses a local judge endpoint when available:

```
PI_JUDGE_URL=http://127.0.0.1:11438/v1/systemone   # default
PI_JUDGE_URL=off                                   # disable (and judge-driven compaction)
PI_JUDGE_TIMEOUT_MS=4000
```

The judge also verifies `plan_task` evidence and can trigger compaction at a
subtask boundary. Every call degrades gracefully when the endpoint is missing.

## Commands, shortcuts, flags

| Entry point | Action |
|---|---|
| `/agent` | selector with the agents loaded from the agents directories |
| `/agent <name>` | activate an agent; an unknown name warns and opens the selector |
| `/agent list` / `/agent cycle` / `/agent off` | list, cycle, restore defaults |
| `/mode` | approval-mode selector |
| `/mode manual\|code\|auto` | set the approval mode (`code-only` is accepted too) |
| `/mode <agent>` | compatibility: activates an agent (agent-modes behaviour) |
| `/plan` | activate the planner |
| `/run` | activate the worker on the active plan |
| `alt+shift+tab` | cycle agents: `worker → planner → explorer → debugger → off` |
| `ctrl+shift+a` | cycle agents, alternate key |
| `alt+m` | cycle approval modes: `manual → code-only → auto` |
| `--agent <name>` | start with an agent |
| `--approval-mode <mode>` | start with an approval mode |

`shift+tab` is **not** used: Pi reserves it for `app.thinking.cycle`, and an
extension shortcut on a reserved key is discarded with a startup diagnostic.
Rebind `app.thinking.cycle` in `keybindings.json` first if you really want
`shift+tab` for agents.

Agent and approval choices are persisted as custom session entries
(`minimal-claude/agent`, `minimal-claude/approval`) and restored on resume.

## Customizing shortcuts

Pi's `keybindings.json` only rebinds built-in action ids, so extension shortcuts
are configured in Pi settings instead (`~/.pi/agent/settings.json` or project
`.pi/settings.json`), under `minimalClaude`:

```json
{
  "minimalClaude": {
    "shortcuts": {
      "agentCycle": "alt+shift+tab",
      "agentCycleAlt": "ctrl+shift+a",
      "approvalCycle": "alt+m"
    },
    "agentOrder": ["worker", "planner", "explorer", "debugger"],
    "mode": "manual"
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `shortcuts.agentCycle` | `alt+shift+tab` | cycle agents |
| `shortcuts.agentCycleAlt` | `ctrl+shift+a` | second agent-cycle key |
| `shortcuts.approvalCycle` | `alt+m` | cycle approval modes |
| `agentOrder` | `worker, planner, explorer, debugger` | rotation/completion order; other discovered agents follow alphabetically |
| `mode` | `manual` | approval mode used when neither the flag nor the session entry sets one |

Each shortcut accepts one key id (`alt+shift+tab`, `ctrl+shift+g`, ...) or
`"off"` / `false` / `null` to disable it. Invalid keys warn and fall back to
the default. Duplicate keys warn and the second binding is skipped.

Configuration is read from `session_start` (settings are not initialized during
extension load), so `/reload` applies edits. Verify what Pi actually bound with
`/hotkeys`. Defaults are free of built-in conflicts; `alt+shift+tab` needs a
terminal that reports Alt+Shift separately (Kitty keyboard protocol). If yours
does not, set `agentCycle` to another key.

Environment overrides take precedence over settings:

- `PI_MINIMAL_CLAUDE_AGENT_CYCLE`, `PI_MINIMAL_CLAUDE_AGENT_CYCLE_ALT`,
  `PI_MINIMAL_CLAUDE_APPROVAL_CYCLE`
- `PI_MINIMAL_CLAUDE_SHORTCUTS=off` registers no shortcuts at all
- `PI_MINIMAL_CLAUDE_DISABLED=1` loads the extension as a no-op

## Plan workflow

1. `/plan` → planner. It researches with `explore` and writes the plan with
   `plan_write` into `.pi/plans/<slug>.md` (`status: active`).
2. At `agent_end` the plan is offered: run it with the worker, edit it by hand,
   or discard it.
3. Worker calls `plan_task` to list tasks, and marks each one with
   `plan_task({ id, done: true, evidence })`.
4. `debugger` inserts marked probe lines with `debug_print` and strips them all
   with `debug_print({ remove: true })` before leaving.

## Coexistence

`~/.pi/extensions/flow/index.ts` and `~/.pi/agent/extensions/agent-modes.ts`
register the same command names (`/mode`, `/plan`, `/run`, `/agent`). Disable
them when this package is enabled, for example:

```bash
mv ~/.pi/agent/extensions/agent-modes.ts ~/.pi/agent/extensions/agent-modes.ts.disabled
```

`/mode <agent>` keeps working as an agent switch, so muscle memory survives the
migration, but do not run two extensions that both own `/mode`. This package no
longer registers `shift+tab`, so the built-in thinking cycle stays intact.

## Development

```bash
npm install        # dev-only: typescript, jiti, typebox, Pi type packages
npm run typecheck
npm test           # smoke (fake ExtensionAPI) + Pi loader parity
npm run publish:check:strict   # package/pub audit before publishing
```

Release steps live in [PUBLISHING.md](PUBLISHING.md).

The smoke test uses a temporary `HOME` and workspace: agent discovery, ordered
agent switching, all three approval modes, shortcut registration and rebinding
(settings, env, `off`, invalid key), `/mode` and `/agent` fallbacks, the plan
guard, `plan_write`/`plan_task`, `debug_print`, `explore` delegation and the
planner→worker hand-off.
