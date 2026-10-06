# clean-end-of-session

> **Compatibility:** last tested and approved with **Claude Code 2.1.291**.

Tired of hitting the usage limit of your Pro or Max subscription right in the middle of a task? Or worse: lying awake at night, afraid Claude is quietly burning through all of your extra usage? Relax. Embrace **clean-end-of-session**.

A Claude Code mod that winds your agents down **cleanly** before your subscription credit runs out, instead of letting the limit cut them off in the middle of a task.

When the session credit gets close to its limit, the mod stops new work. Every running subagent gets a few more tool calls to reach a consistent state, then must hand back a status report. The orchestrator turns these reports into a **resume memo** at the root of your repository, which you use to pick the work up once your credit is back.

## What happens

| Phase | When | What the mod does |
| --- | --- | --- |
| **armed** | Normal use | Watches the credit windows Claude Code reports. Nothing else. |
| **stopping** | 5-hour session window ≥ **90%**, or 7-day window ≥ **95%** (or `/clean-end-of-session stop`) | Refuses new subagents. Warns every running subagent: finish or revert the current change within **5 tool calls**, then return a status report (done / half done with files / next step / watch-outs). After that, its tools are cut off. Tells the orchestrator to write the resume memo once the last report is in. |
| **overage** | A window reaches 100% | Lets the clean stop finish on paid extra usage, up to an estimated **$2**, and nothing else. |
| **stopped** / **braked** | The memo is written, or the overage budget is spent | No request leaves for the model anymore. A red band above the prompt says so. `/clean-end-of-session reset` resumes. |

The weekly threshold is higher than the session one on purpose: the last 10% of a week is about a whole 5-hour session.

### The resume memo

As soon as the stop starts, the mod writes a provisional `CLEAN-END-OF-SESSION_<date>.md` at the root of the git repository the session works in (else in the session's root folder). It copies in each subagent's status report as it arrives, so the file is useful even if the orchestrator never gets to write its own memo. The orchestrator then replaces the file with the full memo: the overall goal, each agent's state, the decisions made, and how to resume. The mod never overwrites a memo the orchestrator wrote.

The session ends once that memo is written, or after two orchestrator turns that did not write it.

## Settings

In `/config`, the mod's settings are folded under a single **▸ clean-end-of-session** row, so they don't clutter the menu.

> **To open it, set that row to `true`.** The `/config` menu has no real collapsible groups, so the chevron is a toggle in disguise: `true` unfolds the settings below it (the row turns into **▾ clean-end-of-session**), `false` folds them away again. If the settings don't show up right away, close and reopen `/config`.

Once unfolded, every setting starts with `clean-end-of-session ·`:

| Setting | Default | Meaning |
| --- | --- | --- |
| Session trigger threshold (%) | 90 | Use of the 5-hour window that starts the clean stop |
| Weekly trigger threshold (%) | 95 | Use of the 7-day window that starts the clean stop |
| Overage budget ($) | 2 | Estimated spend allowed past 100% to finish the stop |
| Grace tool calls | 5 | Tool calls each subagent keeps after its warning |

## Install

This repository is its own plugin marketplace:

```sh
claude plugin marketplace add Rctt27/clean-end-of-session
claude plugin install clean-end-of-session@clean-end-of-session
```

Then run `/reload-plugins`, or restart Claude Code.

Or from a local clone, for one session or for every session:

```sh
claude --plugin-dir /path/to/clean-end-of-session
```

```jsonc
// ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/clean-end-of-session" } }
```

## Requirements

- **Claude Code with function-hook plugins (mods).** This API is in early access and may change between releases. The mod was built and tested on Claude Code **2.1.289 – 2.1.291**; the latest version tested and approved is **2.1.291**.
- **A Claude Pro or Max subscription.** Claude Code reports credit percentages only on a subscription. With an API key, the thresholds never fire, and only `/clean-end-of-session stop` works.
- **Optional: extra usage** turned on in your claude.ai usage settings, with a monthly cap. Without it there is no overage: at 100% Claude Code is cut off as usual, so the clean stop must fit within the margin before 100%.

## Commands

| Command | Effect |
| --- | --- |
| `/clean-end-of-session` or `status` | Shows the phase, the credit windows, the agents warned and the memo path |
| `/clean-end-of-session stop` | Starts the clean stop now, whatever the credit |
| `/clean-end-of-session reset` or `on` | Re-arms the mod, e.g. once your credit is back |
| `/clean-end-of-session off` | Ignores the thresholds for this session |

The command runs at once, even while a turn is running.

## Limits worth knowing

- **The overage budget is an estimate.** It is the session's cost at API prices since a window reached 100%, which is how extra usage is billed. It is not your invoice. Your real safety net is the monthly cap you set on claude.ai.
- **The behaviour past 100% depends on Claude Code.** With extra usage on, Claude Code may continue on its own or ask you first. If it asks, the clean stop waits for your answer.
- **A tool already running is not interrupted.** The mod refuses the *next* tool call, so a long command runs to its end.
- **Teammates running in their own terminal pane** are outside the mod's reach. Subagents started by the Agent tool are covered.
- **Some details are internal to Claude Code.** Status reports are captured from the subagent hand-back tool (`SubagentHandback`). If it changes, the provisional memo loses the reports and the rest still works.

## Development

```sh
claude plugin validate .   # what the engine would load or refuse
claude plugin test .       # the tests in tests/
```

While you edit the mod, load it with `--plugin-dir`: each save reloads it in the running session.

## License

MIT, see [LICENSE](./LICENSE).
