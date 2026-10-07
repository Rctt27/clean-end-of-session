# graceful-stop

A Claude Code mod (a plugin of function hooks) that winds subagents down cleanly before the subscription credit runs out and has the orchestrator write a resume memo. See `README.md` for the user-facing behaviour.

The repository is both the plugin and its own marketplace: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (plugin `source: "./"`).

## Layout

- `hooks/register.tsx`: the whole mod, one hooks module. Helpers at the top, `register(on, options)` at the bottom with every hook.
- `types/index.d.ts`: the `$.state` contract (`GracefulStopStatus`, `GracefulStopAgent`). Every `$.state` key the module uses must be declared here.
- `tests/graceful-stop.test.ts`: `claude plugin test` suite; `world()` mocks the engine beneath the plugin.
- `.claude-plugin/types/` is written by Claude Code at each load and is git-ignored. It holds the API declarations for the version in use; grep it (`claude-code/index.d.ts`) for an event or a `$` method before using it.

## Checks (run all three before committing)

```sh
claude plugin validate .
claude plugin test .
tsc -p .            # needs .claude-plugin/types, laid only when the mod is loaded with --plugin-dir
```

For a live run, load the mod with `claude --plugin-dir .` (saves hot-reload), launch two or three background subagents on a long read-only task, then `/graceful-stop stop`.

## How it works

Phases (`GracefulStopStatus.phase`): `armed` → `stopping` → `overage` (a window at 100%) → `stopped` | `braked`; plus `off`.

- `session.measure` reads the rate-limit windows and starts the stop: `five_hour` uses `sessionThreshold` (90), `seven_day` uses `weeklyThreshold` (95), any other kind the session one.
- `agent.spawn` refuses new subagents once the stop started.
- `tool.call` counts each subagent's calls after its warning and denies past `graceToolCalls`.
- `turn.step` is the brake: in `stopped` / `braked` it answers itself, so no request reaches the API.
- `turn.complete`: a subagent's run records its report; a main turn with no agent left ends the stop once the memo is written, or after `MAX_IDLE_TURNS` (2) turns that did not write it.
- The memo goes to the git repository root containing `$.session.root()`, else to that root. The provisional memo starts with `FALLBACK_MARK`; the mod never overwrites a file without it.
- `/graceful-stop resume` (`resume()`): refuses while a stop is under way or a window is still over its threshold (`blockingWindows`), says when the last one resets (`whenText`, `today 18:40 (in 2 h 13)`), else re-arms and submits `resumePrompt` naming the memo (`findMemo`: this session's, the one kept in `$.store`, else the newest `GRACEFUL-STOP_*.md` at the memo root).
- `/gs` (`ALIAS`) is a second registered command with the same `runCommand` and the same card; `COMMANDS` lists both, and each loop in `register` hooks both.
- `drawPanel` draws the mod's card, both as the `AbovePrompt` band and as the command's `CommandOutput` row (the model still reads the command's text; the row adds it on top as a `› ` notice, none for `status`). While armed, its header lists the settings (`settingsText`): thresholds, overage budget, grace calls.
- The `AbovePrompt` band is always drawn (except while a survey holds it): the phase (`phaseLabel`), a gauge per window (`gaugesOf` → `gaugeCells`: eighth-block fill, green → amber → red by `gradientAt`, a `▏` mark at the threshold; a `Raster` on the terminal, the same cells as `textRuns` elsewhere), and two Buttons, `toggle` (hotkey `o`, same as `off`/`on`) and `resume` (hotkey `r`, `pressResume`: `resume()` said in a toast). `resume` is dimmed, never hidden, while `resume()` would refuse or `isWorking`.
- `armAtStart` (`/config`, default true): false makes `session.start` put a fresh session in `off`.

## Things that are not obvious

- **Validator rule:** `$` may only be passed to functions declared at the top level of the module (a `function` declaration or a `const` bound to one). Closures inside `register` that take `$` are refused. This is why every helper taking `$` lives above `register`, with the settings passed as a `Config` argument.
- **Subagent reports** arrive through Claude Code's internal `SubagentHandback` tool, in its `message` field, not in the run's final answer, which is often empty. The `tool.call` hook captures it and never counts or denies that tool. It is internal: re-check the name and the field when Claude Code updates.
- **Warnings** are delivered with `$.session.append` (a hidden user row), falling back to `$.session.send`. Keep it that way: changing the system prompt through `prompt.compose` would invalidate the prompt cache of the whole conversation, exactly when credit is scarce.
- **Overage budget:** the spend past 100% is estimated as the growth of `$.session.usage().cost.usd` since the window reached 100%. It is an estimate at API prices, not the invoice.
- **Stale credit readings:** the rate-limit figures come with the API's answers. Once the brake holds, none arrives, so the reading stays at its last value. `blockingWindows` counts a window whose `resetsAt` has passed as reset; never compare the percentage alone.
- **`$.store` (kept between sessions):** `credit` (the last rate-limit reading, written on each `session.measure` that moved it), `creditAt` (when it was read) and `memoPath` (the last memo). A fresh session has no reading before its first request and no `$.state`, so `resume` relies on them.
- **No `$.prompt.submit` from `command.run`:** the host refuses it (it would wait on the command's own run). `resume` schedules it with `$.clock.after(1, ...)`, which runs once the command has answered.
- **What the band reads redraws it:** `status`, `credit` (written by `session.measure`) and `minute` (ticked every 60 s from `session.start`, so the reset countdowns move). Reading any of them in the render hook is the subscription; keep those reads even when the value looks unused.
- **`session.start` fires again on each reload:** the `started` atom keeps `armAtStart` from turning a session the person armed back off.
- **`Raster` is the terminal's:** test `e.surface === 'terminal'`, not `'Raster' in ui`: another surface's table can hold it as a fragment that draws nothing. Its `cells` is base64 of u32 triplets; the module encodes it itself (`toBase64`).
- **The band's fold is the person's:** `[-]` / `ctrl+x ctrl+a` folds it and Claude Code remembers it; no API unfolds it. The command's card is the way to show the state without a click.
- **Renamed from `clean-end-of-session`** (up to 0.4.0): `MEMO_FILE` still matches the memos written under that name. The `$.store` is the plugin's, so the rename started it empty.
- **Module variables reset on every reload** (each save, each `/config` change). State that must survive goes in `$.state` (the `status` atom).
- **Yellow rows:** `ui.render` hooks on `UserMessage` and `AssistantMessage` redraw any row whose text starts with `[graceful-stop]` in `MOD_COLOR` under `MOD_LABEL`; the command's output is the card instead. Every message the mod sends must keep that tag, or it will read as the agent's own. Drawing only: the stored row and what the model reads are unchanged.
- **`/config` chevron:** the `showSettings` boolean is relabelled `▸`/`▾ graceful-stop` by a `config.describe` hook, which hides the other rows while it is `false`. The menu has no real groups.

## Test kit quirks

- The test's own `on(...)` hooks stand for the engine. Answers to `$` operations are wrapped: `{ value: ... }` (e.g. `agent.list`, `fs.read`, `session.usage`, `ui.toast`).
- A `session.append` hook that answers without calling `next` is skipped, and a plugin's own `$.session.append` never reaches the test's hooks. The tests therefore observe warnings through the `session.send` fallback.
- Paths reach `fs.*` resolved by the engine (`/proj` becomes `C:\proj` on Windows): `world()` keeps files under `norm(path)`; compare with `[\\/]` in regexes.
- `world()` starts `mock.clock` at `NOW`, 2 h 13 before `RESETS_AT`, and `mock.store` with `where.store`. The resume prompt goes out on a timer: `await w.clock.advance(1)` before looking at `w.prompts`.
- The band is mounted with `band($, surface, isWorking?)` and driven by key (`toggle`, `resume`). Raising `session.start` needs `host(on)`, which answers `command.register`, `ui.invalidate` and `session.start` beneath the plugin.

## Conventions

- Every text the mod shows or sends (model notes, toasts, band, command output, provisional memo) is in English. The notes ask the orchestrator to write the memo, and the subagents their reports, in the user's language: keep that sentence in `mainNote` and `agentWarning`.
- Release: bump `version` in both `plugin.json` and `marketplace.json`, update the tested Claude Code version in `README.md`, commit, then tag `vX.Y.Z` with a GitHub release. `claude plugin update` relies on the version number.
