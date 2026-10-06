# clean-end-of-session

A Claude Code mod (a plugin of function hooks) that winds subagents down cleanly before the subscription credit runs out and has the orchestrator write a resume memo. See `README.md` for the user-facing behaviour.

The repository is both the plugin and its own marketplace: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (plugin `source: "./"`).

## Layout

- `hooks/register.tsx`: the whole mod, one hooks module. Helpers at the top, `register(on, options)` at the bottom with every hook.
- `types/index.d.ts`: the `$.state` contract (`CleanEndStatus`, `CleanEndAgent`). Every `$.state` key the module uses must be declared here.
- `tests/clean-end.test.ts`: `claude plugin test` suite; `world()` mocks the engine beneath the plugin.
- `.claude-plugin/types/` is written by Claude Code at each load and is git-ignored. It holds the API declarations for the version in use; grep it (`claude-code/index.d.ts`) for an event or a `$` method before using it.

## Checks (run all three before committing)

```sh
claude plugin validate .
claude plugin test .
tsc -p .            # needs .claude-plugin/types, laid only when the mod is loaded with --plugin-dir
```

For a live run, load the mod with `claude --plugin-dir .` (saves hot-reload), launch two or three background subagents on a long read-only task, then `/clean-end-of-session stop`.

## How it works

Phases (`CleanEndStatus.phase`): `armed` → `stopping` → `overage` (a window at 100%) → `stopped` | `braked`; plus `off`.

- `session.measure` reads the rate-limit windows and starts the stop: `five_hour` uses `sessionThreshold` (90), `seven_day` uses `weeklyThreshold` (95), any other kind the session one.
- `agent.spawn` refuses new subagents once the stop started.
- `tool.call` counts each subagent's calls after its warning and denies past `graceToolCalls`.
- `turn.step` is the brake: in `stopped` / `braked` it answers itself, so no request reaches the API.
- `turn.complete`: a subagent's run records its report; a main turn with no agent left ends the stop once the memo is written, or after `MAX_IDLE_TURNS` (2) turns that did not write it.
- The memo goes to the git repository root containing `$.session.root()`, else to that root. The provisional memo starts with `FALLBACK_MARK`; the mod never overwrites a file without it.

## Things that are not obvious

- **Validator rule:** `$` may only be passed to functions declared at the top level of the module (a `function` declaration or a `const` bound to one). Closures inside `register` that take `$` are refused. This is why every helper taking `$` lives above `register`, with the settings passed as a `Config` argument.
- **Subagent reports** arrive through Claude Code's internal `SubagentHandback` tool, in its `message` field, not in the run's final answer, which is often empty. The `tool.call` hook captures it and never counts or denies that tool. It is internal: re-check the name and the field when Claude Code updates.
- **Warnings** are delivered with `$.session.append` (a hidden user row), falling back to `$.session.send`. Keep it that way: changing the system prompt through `prompt.compose` would invalidate the prompt cache of the whole conversation, exactly when credit is scarce.
- **Overage budget:** the spend past 100% is estimated as the growth of `$.session.usage().cost.usd` since the window reached 100%. It is an estimate at API prices, not the invoice.
- **Module variables reset on every reload** (each save, each `/config` change). State that must survive goes in `$.state` (the `status` atom).
- **Yellow rows:** `ui.render` hooks on `UserMessage`, `AssistantMessage` and `CommandOutput` redraw any row whose text starts with `[clean-end-of-session]` (or the mod's command output) in `MOD_COLOR` under `MOD_LABEL`. Every message the mod sends must keep that tag, or it will read as the agent's own. Drawing only: the stored row and what the model reads are unchanged.
- **`/config` chevron:** the `showSettings` boolean is relabelled `▸`/`▾ clean-end-of-session` by a `config.describe` hook, which hides the other rows while it is `false`. The menu has no real groups.

## Test kit quirks

- The test's own `on(...)` hooks stand for the engine. Answers to `$` operations are wrapped: `{ value: ... }` (e.g. `agent.list`, `fs.read`, `session.usage`, `ui.toast`).
- A `session.append` hook that answers without calling `next` is skipped, and a plugin's own `$.session.append` never reaches the test's hooks. The tests therefore observe warnings through the `session.send` fallback.
- Paths reach `fs.*` resolved by the engine (`/proj` becomes `C:\proj` on Windows): compare with `[\\/]` in regexes.

## Conventions

- Every text the mod shows or sends (model notes, toasts, band, command output, memo) is in English.
- Release: bump `version` in both `plugin.json` and `marketplace.json`, update the tested Claude Code version in `README.md`, commit, then tag `vX.Y.Z` with a GitHub release. `claude plugin update` relies on the version number.
