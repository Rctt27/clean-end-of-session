# clean-end-of-session

> **Compatibility:** last tested and approved with **Claude Code 2.1.292**.

Tired of hitting the usage limit of your Pro or Max subscription right in the middle of a task? Or worse: lying awake at night, afraid Claude is quietly burning through all of your extra usage? Relax. Embrace **clean-end-of-session**.

A Claude Code mod that winds your agents down **cleanly** before your subscription credit runs out, instead of letting the limit cut them off in the middle of a task.

When the session credit gets close to its limit, the mod stops new work. Every running subagent gets a few more tool calls to reach a consistent state, then must hand back a status report. The orchestrator turns these reports into a **resume memo** at the root of your repository. Once your credit is back, one command picks the work up from it.

## What happens

| Phase | When | What the mod does |
| --- | --- | --- |
| **armed** | Normal use | Watches the credit windows Claude Code reports. Nothing else. |
| **stopping** | 5-hour session window ≥ **90%**, or 7-day window ≥ **95%** (or `/clean-end-of-session stop`) | Refuses new subagents. Warns every running subagent: finish or revert the current change within **5 tool calls**, then return a status report (done / half done with files / next step / watch-outs). After that, its tools are cut off. Tells the orchestrator to write the resume memo once the last report is in. |
| **overage** | A window reaches 100% | Lets the clean stop finish on paid extra usage, up to an estimated **$2**, and nothing else. |
| **stopped** / **braked** | The memo is written, or the overage budget is spent | No request leaves for the model anymore. A band above the prompt says so, with the time your credit is back: `today 18:40 (in 2 h 13)`. `/clean-end-of-session resume` then picks the work up. |

The weekly threshold is higher than the session one on purpose: the last 10% of a week is about a whole 5-hour session.

Everything the mod says in the conversation is drawn in **yellow** under a `⏹ clean-end-of-session` label: its notes to the orchestrator, the brake's answers (which look like a reply but come from no model), and its command output. You always tell the mod's actions apart from the agent's own work. This changes the drawing only, never what the model reads; press ctrl+o for the raw transcript.

### The resume memo

As soon as the stop starts, the mod writes a provisional `CLEAN-END-OF-SESSION_<date>.md` at the root of the git repository the session works in (else in the session's root folder). It copies in each subagent's status report as it arrives, so the file is useful even if the orchestrator never gets to write its own memo. The orchestrator then replaces the file with the full memo: the overall goal, each agent's state, the decisions made, and how to resume. The mod never overwrites a memo the orchestrator wrote.

The session ends once that memo is written, or after two orchestrator turns that did not write it.

The memo and the agents' status reports are written in your language: the language you prompt in, even though the mod's own messages are in English. The provisional memo keeps its few headings in English.

### Resuming

`/clean-end-of-session resume` does it all in one go: it checks that your credit is back, re-arms the mod and hands the orchestrator a prompt to read the memo and carry on, relaunching the unfinished tasks from their next step.

If a window is still over its threshold (90% of the 5-hour window, 95% of the 7-day one), it refuses and tells you when to come back:

```
Your credits have not been reset yet. Reset time: today 18:40 (in 2 h 13).
```

The time is the reset of the last window holding you back: when the 5-hour window resets but the week is still at 96%, it is the weekly reset.

It works in the same session as in a new one. The mod keeps the last credit reading and the memo's path in its own store, under your Claude Code configuration folder, so a fresh `claude` started in the same repository knows both. Without a kept path it takes the newest `CLEAN-END-OF-SESSION_*.md` at the root of the repository. A new session has only the memo to go on; `claude --resume <session>` brings back the conversation too.

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

- **Claude Code with function-hook plugins (mods).** This API is in early access and may change between releases. The mod was built and tested on Claude Code **2.1.289 – 2.1.292**; the latest version tested and approved is **2.1.292**.
- **A Claude Pro or Max subscription.** Claude Code reports credit percentages only on a subscription. With an API key, the thresholds never fire, and only `/clean-end-of-session stop` works.
- **Optional: extra usage** turned on in your claude.ai usage settings, with a monthly cap. Without it there is no overage: at 100% Claude Code is cut off as usual, so the clean stop must fit within the margin before 100%.

## Commands

| Command | Effect |
| --- | --- |
| `/clean-end-of-session` or `status` | Shows the phase, the credit windows, the agents warned and the memo path |
| `/clean-end-of-session stop` | Starts the clean stop now, whatever the credit |
| `/clean-end-of-session resume` | Once your credit is back: re-arms the mod and relaunches the work from the resume memo |
| `/clean-end-of-session on` | Re-arms the mod without relaunching anything |
| `/clean-end-of-session off` | Ignores the thresholds for this session |

The command runs at once, even while a turn is running.

## Limits worth knowing

- **The overage budget is an estimate.** It is the session's cost at API prices since a window reached 100%, which is how extra usage is billed. It is not your invoice. Your real safety net is the monthly cap you set on claude.ai.
- **The behaviour past 100% depends on Claude Code.** With extra usage on, Claude Code may continue on its own or ask you first. If it asks, the clean stop waits for your answer.
- **The reset time comes from Claude Code.** Once the session is stopped, no request leaves, so the credit reading stays where it was; the mod trusts the reset time that came with it and counts a window as reset once that time has passed. Times are shown in your computer's local time.
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
