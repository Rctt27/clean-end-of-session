import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, ResolveInput, SessionRateLimit } from 'claude-code'

import type { GracefulStopAgent, GracefulStopCredit, GracefulStopStatus } from '../types'

const NAME = 'graceful-stop'
// A short name for the same command: /gs.
const ALIAS = 'gs'
const COMMANDS = [NAME, ALIAS]
const TAG = `[${NAME}]`
const FALLBACK_MARK = `<!-- ${NAME}:fallback -->`
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])
// Main turns the orchestrator gets, once every agent is done, to write the
// memo before the mod stops the session anyway.
const MAX_IDLE_TURNS = 2
// The tool a subagent hands its final report back with; never counted or cut off.
const HANDBACK_TOOL = 'SubagentHandback'
// The /config row that folds the mod's other rows away, like a chevron.
const TOGGLE_KEY = `${NAME}.showSettings`
// `$.store` keys, kept between sessions: the last credit reading and the last
// memo, so a fresh session can still tell when to resume and from what.
const CREDIT_KEY = 'credit'
const CREDIT_AT_KEY = 'creditAt'
const MEMO_KEY = 'memoPath'
// Memos written before the mod was renamed keep the old prefix.
const MEMO_FILE = /^(GRACEFUL-STOP|CLEAN-END-OF-SESSION)_.*\.md$/

const ARMED: GracefulStopStatus = {
  phase: 'armed',
  trigger: null,
  resetsAt: null,
  baselineUsd: null,
  spentUsd: 0,
  warned: {},
  memoPath: null,
  agents: [],
  idleTurns: 0,
}

const OFF: GracefulStopStatus = { ...ARMED, phase: 'off' }

const status = atom({ plugin: 'graceful-stop', key: 'status' } as const, ARMED)
const credit = atom({ plugin: 'graceful-stop', key: 'credit' } as const, null)
const minute = atom({ plugin: 'graceful-stop', key: 'minute' } as const, 0)
const started = atom({ plugin: 'graceful-stop', key: 'started' } as const, false)

type Engine = EngineInterface
type Config = {
  /** Trigger for the 5-hour session window, in percent. */
  sessionThreshold: number
  /** Trigger for the 7-day window: its last few percent are about one whole session. */
  weeklyThreshold: number
  budgetUsd: number
  graceCalls: number
  /** Whether a new session starts armed, else off until the person arms it. */
  armAtStart: boolean
}

// Whether the main loop is in a turn; a reload forgets it, which only means
// the next clean stop may judge the session idle and write no memo.
let isMainBusy = false

const isWatching = (s: GracefulStopStatus) => s.phase === 'stopping' || s.phase === 'overage'
const isHalted = (s: GracefulStopStatus) => s.phase === 'stopped' || s.phase === 'braked'

const usd = (n: number) => `$${n.toFixed(2)}`

const peakOf = (windows: readonly SessionRateLimit[]) =>
  windows.reduce<SessionRateLimit | null>(
    (top, w) => (top === null || w.percentUsed > top.percentUsed ? w : top),
    null,
  )

// The weekly window has its own threshold; the session window and any other
// (a gateway's spend limit) take the session one.
const thresholdOf = (cfg: Config, kind: string) =>
  kind === 'seven_day' ? cfg.weeklyThreshold : cfg.sessionThreshold

// The window past its threshold by the widest margin, or null.
const crossedWindow = (cfg: Config, windows: readonly SessionRateLimit[]) =>
  windows
    .filter(w => w.percentUsed >= thresholdOf(cfg, w.kind))
    .reduce<SessionRateLimit | null>(
      (top, w) =>
        top === null ||
        w.percentUsed - thresholdOf(cfg, w.kind) > top.percentUsed - thresholdOf(cfg, top.kind)
          ? w
          : top,
      null,
    )

const thresholdsText = (cfg: Config) =>
  `session ${cfg.sessionThreshold}%, weekly ${cfg.weeklyThreshold}%`

const describeWindow =(w: SessionRateLimit | null) =>
  w === null ? 'credit unknown' : `${w.kind} at ${w.percentUsed}%`

// The windows still over their threshold. A reading taken before its window
// reset counts as reset: once the brake holds, no request refreshes it.
const blockingWindows = (cfg: Config, windows: readonly SessionRateLimit[], now: number) =>
  windows.filter(
    w =>
      w.percentUsed >= thresholdOf(cfg, w.kind) &&
      !(w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now),
  )

// When the last blocking window resets: NaN when one of them gives no time.
const lastResetOf = (windows: readonly SessionRateLimit[]) =>
  Math.max(...windows.map(w => (w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt))))

const pad = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayOf = (at: Date, now: Date) => {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'

  return `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`
}

const remainingOf = (ms: number) => {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`

  return `in ${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`
}

// A time in the person's local time: `today 18:40`.
const clockOf = (at: number, now: number) => {
  const date = new Date(at)

  return `${dayOf(date, new Date(now))} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// A reset time in the person's local time: `today 18:40 (in 2 h 13)`.
const whenText = (at: number, now: number) =>
  Number.isNaN(at) ? 'at an unknown time' : `${clockOf(at, now)} (${remainingOf(at - now)})`

const stamp = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace('T', '_').replace(':', 'h')

const normalize = (path: string) => path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

const isWithin = (path: string, dir: string) =>
  normalize(path) === normalize(dir) || normalize(path).startsWith(`${normalize(dir)}/`)

const handbackText = (input: object) => {
  const message = (input as { message?: unknown }).message

  return typeof message === 'string' ? message : null
}

const joinPath = (dir: string, file: string) => {
  const sep = dir.includes('\\') ? '\\' : '/'

  return dir.replace(/[\\/]+$/, '') + sep + file
}

const toRecord = (a: AgentInfo): GracefulStopAgent => ({
  id: a.id,
  description: a.description,
  type: a.type,
  status: a.status,
  report: null,
})

const note = (text: string) => ({
  message: { type: 'user' as const, content: [{ type: 'text' as const, text }] },
})

const agentWarning = (cfg: Config, trigger: string) =>
  `${TAG} The Claude session credit is almost used up (${trigger}). Wind down cleanly: start no ` +
  `new step. You have at most ${cfg.graceCalls} more tool calls to leave files in a consistent ` +
  `state (finish or revert the change in progress), then your tools will be cut off. Your final ` +
  `answer must be a status report: 1) what is done; 2) what is half done, with the files involved; ` +
  `3) the exact next step to resume; 4) anything to watch out for. Write the report in the ` +
  `language your task asks its results in, else in the language your task is written in, not ` +
  `in the language of this note.`

const AGENT_CUTOFF =
  `${TAG} Tools cut off: the session credit is almost used up. Call no more tools. Write your ` +
  `final answer now as a status report (done / half done with files / next step / watch-outs).`

// Everything the mod says in the conversation is drawn in this colour, under
// this label, so it never reads as the agent's own work.
const MOD_COLOR = 'yellow'
const MOD_LABEL = `⏹  ${NAME}`
// The panel's frame: a neutral gray that reads on dark and light themes.
const CARD_BORDER = '#71717a'

const isModText = (text: string) => text.trimStart().startsWith(TAG)

// The message without its tag, or a command's output without the plugin name
// the engine prints before it.
const modBody = (text: string) => {
  const body = text.trimStart()
  const prefix = [TAG, ...COMMANDS.map(c => `${c}:`)].find(p => body.startsWith(p)) ?? ''

  return body.slice(prefix.length).trim()
}

const SPAWN_DENIED = `${TAG} Spawn refused: a clean stop is under way, the session credit is almost used up.`

const mainNote = (cfg: Config, trigger: string, agents: number, memoPath: string) =>
  `${TAG} The Claude session credit has reached ${trigger}. Clean stop started: take on no new ` +
  `task and spawn no agent (spawning is blocked). ${agents} active subagent(s) were told to wind ` +
  `down and return a status report. Finish what you are doing as briefly as you can. Write the ` +
  `resume memo as soon as the last report is in, in that same turn (right away if there is no ` +
  `agent): before ending any turn, check whether any agent is still running, and never end a ` +
  `turn just to wait for reports that may already be in. Write it to ${memoPath}, fully ` +
  `replacing the provisional file there: overall goal, each agent's state (done / partial / next ` +
  `step / files), decisions made, and how to resume. Write the memo in the language the user ` +
  `writes in (that of their latest messages if they switched), not in the language of this ` +
  `note. Then stop. Past 100% of the credit, paid ` +
  `overage of at most ${usd(cfg.budgetUsd)} is allowed for this clean stop only: be concise.`

// How to pick the work up again; `back` is when the credit is back
// (whenText), null when it already is.
const resumeHint = (back: string | null) =>
  back === null
    ? `The credit is below the thresholds: /${NAME} resume picks the work up.`
    : `Credit back ${back}: /${NAME} resume then picks the work up.`

const haltText = (cfg: Config, s: GracefulStopStatus, back: string | null) => {
  const why =
    s.phase === 'braked'
      ? `Overage budget used up (${usd(s.spentUsd)} of ${usd(cfg.budgetUsd)}).`
      : `Session stopped cleanly (${s.trigger ?? 'threshold reached'}).`
  const memo = s.memoPath === null ? '' : ` Resume memo: ${s.memoPath}.`

  return `${TAG} ${why}${memo} No request was sent to the model. ${resumeHint(back)}`
}

const resumePrompt = (memoPath: string) =>
  `${TAG} The credit is back: resume the work a clean stop interrupted. Read the resume memo at ` +
  `${memoPath} first, then carry on from it: relaunch each unfinished task from its next step, ` +
  `as subagents where the memo had them, and check the files it lists as half done before ` +
  `building on them. Answer in the language the memo is written in, not in the language of ` +
  `this note.`

const notReset = (back: string) => `Your credits have not been reset yet. Reset time: ${back}.`

async function activeAgents($: Engine) {
  return (await $.agent.list()).filter(a => ACTIVE_AGENT.has(a.status))
}

const agentSection = (a: GracefulStopAgent) => [
  `### ${a.description}`,
  '',
  `- Type: ${a.type}`,
  `- Status: ${a.status}`,
  `- Id: \`${a.id}\``,
  '',
  a.report === null ? '_No status report received._' : a.report.trim(),
  '',
]

async function fallbackMemo($: Engine, s: GracefulStopStatus) {
  const sessionId = await $.session.id()
  const now = new Date(await $.clock.now()).toISOString()

  return [
    FALLBACK_MARK,
    '# Resume memo (provisional)',
    '',
    `Written by the ${NAME} mod at ${now}. The orchestrator was to replace this file with a ` +
      `full memo; if it is still here, the clean stop did not run to the end. Each agent's own ` +
      `status report is copied below as it came in.`,
    '',
    `- Trigger: ${s.trigger ?? 'unknown'}`,
    `- Credit resets at: ${s.resetsAt ?? 'unknown'}`,
    `- Stop state: ${s.phase}${s.phase === 'braked' ? ` (overage ${usd(s.spentUsd)})` : ''}`,
    `- Session: \`${sessionId}\``,
    '',
    '## Agents covered by the stop',
    '',
    ...(s.agents.length === 0 ? ['No subagent was running.', ''] : s.agents.flatMap(agentSection)),
    '## To resume',
    '',
    `1. \`claude --resume ${sessionId}\` brings back the conversation and the agents' status reports.`,
    '2. Otherwise, relaunch each task above from its report.',
    '',
  ].join('\n')
}

async function isMemoReplaced($: Engine, path: string) {
  if (!(await $.fs.exists(path))) return false
  const current = await $.fs.read(path)

  return typeof current === 'string' && !current.startsWith(FALLBACK_MARK)
}

// Writes the mod's own record of the stop, unless the orchestrator already
// replaced it with the real memo; the agents' statuses are refreshed first.
async function writeFallback($: Engine, s: GracefulStopStatus) {
  if (s.memoPath === null || (await isMemoReplaced($, s.memoPath))) return
  const live = new Map((await $.agent.list()).map(a => [a.id, a.status as string]))
  const agents = s.agents.map(a => ({ ...a, status: live.get(a.id) ?? a.status }))
  await $.fs.write(s.memoPath, await fallbackMemo($, { ...s, agents }))
}

async function warnAgent($: Engine, cfg: Config, agentId: string, trigger: string) {
  const text = agentWarning(cfg, trigger)
  const appended = await $.session.append({ ...note(text), agentId }).catch(() => null)
  if (appended === null || 'deny' in appended) {
    await $.session.send({ to: { agentId }, text }).catch(() => undefined)
  }
}

async function warnMain($: Engine, text: string) {
  const appended = await $.session.append(note(text)).catch(() => null)
  if (appended === null || 'deny' in appended) {
    await $.session.send({ to: { sessionId: await $.session.id() }, text }).catch(() => undefined)
  }
}

// The root of the repository the session works in, else its project root.
async function memoDir($: Engine) {
  const root = await $.session.root()
  const repo = await $.session.repo()

  return repo !== null && isWithin(root, repo.root) ? repo.root : root
}

// The session's credit reading, else the last one kept: a fresh session has
// none before its first request.
async function readWindows($: Engine): Promise<readonly SessionRateLimit[]> {
  const live = (await $.session.usage()).rateLimits
  if (live.length > 0) return live
  const kept = await $.store.get(CREDIT_KEY).catch(() => undefined)

  return Array.isArray(kept) ? (kept as SessionRateLimit[]) : []
}

// When the credit is back, as whenText says it, or null when it already is.
async function creditBack($: Engine, cfg: Config) {
  const now = await $.clock.now()
  const blocking = blockingWindows(cfg, await readWindows($), now)

  return blocking.length === 0 ? null : whenText(lastResetOf(blocking), now)
}

async function haltMessage($: Engine, cfg: Config, s: GracefulStopStatus) {
  return haltText(cfg, s, await creditBack($, cfg))
}

// The memo to resume from: this session's, the last one kept, else the newest
// at the root the memos go to.
async function findMemo($: Engine, s: GracefulStopStatus) {
  const kept = await $.store.get(MEMO_KEY).catch(() => undefined)
  for (const path of [s.memoPath, typeof kept === 'string' ? kept : null]) {
    if (path !== null && (await $.fs.exists(path))) return path
  }
  const dir = await memoDir($)
  const newest = (await $.fs.list(dir).catch(() => []))
    .filter(f => f.kind === 'file' && MEMO_FILE.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0]

  return newest === undefined ? null : joinPath(dir, newest.name)
}

// Hands the orchestrator its resume prompt as a turn of its own, once idle.
async function submitResume($: Engine, memoPath: string) {
  const sent = await $.prompt.submit({ text: resumePrompt(memoPath) }).catch(() => null)
  if (sent === null || sent.drop !== undefined) {
    $.ui.toast(`${NAME}: the resume prompt did not go through${sent?.drop ? ` (${sent.drop})` : ''}.`)
  }
}

// `/graceful-stop resume`: re-arms and relaunches the work from the
// memo, or says why not.
async function resume($: Engine, cfg: Config) {
  const s = await read($, status)
  if (isWatching(s)) return `A clean stop is under way: resume once it has ended.`
  const back = await creditBack($, cfg)
  if (back !== null) return notReset(back)
  const memoPath = await findMemo($, s)
  if (memoPath === null) {
    return `No resume memo found in ${await memoDir($)}. /${NAME} on re-arms without resuming.`
  }

  await update($, status, () => ARMED)
  // A command may not submit a prompt itself (it would wait on its own run):
  // a timer submits it once the command has answered.
  $.clock.after(1, () => submitResume($, memoPath))

  return `Re-armed at ${thresholdsText(cfg)}. Resuming from ${memoPath}.`
}

async function startStop($: Engine, cfg: Config, top: SessionRateLimit | null, trigger: string) {
  if ((await read($, status)).phase !== 'armed') return

  const agents = await activeAgents($)
  const hasWork = agents.length > 0 || isMainBusy
  const memoPath = hasWork
    ? joinPath(await memoDir($), `GRACEFUL-STOP_${stamp(await $.clock.now())}.md`)
    : null
  const stop: GracefulStopStatus = {
    ...ARMED,
    phase: hasWork ? 'stopping' : 'stopped',
    trigger,
    resetsAt: top?.resetsAt ?? null,
    warned: Object.fromEntries(agents.map(a => [a.id, 0])),
    memoPath,
    agents: agents.map(toRecord),
  }
  await update($, status, () => stop)

  if (memoPath === null) {
    $.ui.toast(
      `${NAME}: ${trigger}, nothing running. No more requests will leave. ` +
        resumeHint(await creditBack($, cfg)),
    )
    return
  }

  await writeFallback($, stop)
  await $.store.set(MEMO_KEY, memoPath).catch(() => undefined)
  await Promise.all(agents.map(a => warnAgent($, cfg, a.id, trigger)))
  await warnMain($, mainNote(cfg, trigger, agents.length, memoPath))
  $.ui.toast(`${NAME}: ${trigger}, clean stop of ${agents.length} agent(s) started.`)
}

// Keeps an agent the stop did not see at its start (spawned just before it).
async function adoptAgent($: Engine, id: string) {
  const found = (await $.agent.list()).find(a => a.id === id)
  const record: GracefulStopAgent = found === undefined
    ? { id, description: 'unknown task', type: 'unknown', status: 'running', report: null }
    : toRecord(found)
  await update($, status, s =>
    s.agents.some(a => a.id === id) ? s : { ...s, agents: [...s.agents, record] },
  )
}

// Copies a subagent's status report into the memo: its hand-back message, or
// its final answer when it handed nothing back; an empty answer keeps the
// report already captured.
async function recordReport($: Engine, id: string, report: string, agentStatus: string) {
  if (!(await read($, status)).agents.some(a => a.id === id)) await adoptAgent($, id)
  const text = report.trim() === '' ? null : report
  await update($, status, s => ({
    ...s,
    agents: s.agents.map(a =>
      a.id === id ? { ...a, status: agentStatus, report: text ?? a.report } : a,
    ),
  }))
  await writeFallback($, await read($, status))
}

// A main turn ended with every agent done: the stop is over once the memo is
// written, or after MAX_IDLE_TURNS turns that did not write it.
async function settleMainTurn($: Engine, cfg: Config, s: GracefulStopStatus) {
  const isWritten = s.memoPath === null || (await isMemoReplaced($, s.memoPath))
  if (isWritten || s.idleTurns + 1 >= MAX_IDLE_TURNS) {
    await halt($, cfg, 'stopped')
    return
  }
  await update($, status, cur => (isWatching(cur) ? { ...cur, idleTurns: cur.idleTurns + 1 } : cur))
}

async function halt($: Engine, cfg: Config, phase: 'stopped' | 'braked') {
  await update($, status, s => (isWatching(s) ? { ...s, phase } : s))
  const s = await read($, status)
  if (s.phase !== phase) return
  await writeFallback($, s)
  const back = await creditBack($, cfg)
  $.ui.toast(
    (phase === 'braked'
      ? `${NAME}: overage budget used up, no more requests leave.`
      : `${NAME}: clean stop complete.`) + ` ${resumeHint(back)}`,
  )
}

async function checkBudget($: Engine, cfg: Config, costUsd: number | undefined) {
  const s = await read($, status)
  if (s.phase !== 'overage' || s.baselineUsd === null || costUsd === undefined) return
  const spent = Math.max(0, costUsd - s.baselineUsd)
  await update($, status, cur => (cur.phase === 'overage' ? { ...cur, spentUsd: spent } : cur))
  if (spent >= cfg.budgetUsd) await halt($, cfg, 'braked')
}

async function statusText($: Engine, cfg: Config) {
  const s = await read($, status)
  const usage = await $.session.usage()
  const windows = usage.rateLimits.map(w => `${w.kind} ${w.percentUsed}%`).join(', ') || 'no reading yet'
  const warned = Object.entries(s.warned)
  const back = await creditBack($, cfg)
  const lines = [
    `Phase: ${s.phase} (thresholds ${thresholdsText(cfg)}, overage budget ${usd(cfg.budgetUsd)}, grace ${cfg.graceCalls} calls)`,
    `Credit: ${windows}`,
    back === null ? null : `Credit back: ${back}`,
    s.trigger === null ? null : `Trigger: ${s.trigger}`,
    s.phase === 'overage' || s.phase === 'braked' ? `Estimated overage: ${usd(s.spentUsd)}` : null,
    warned.length === 0 ? null : `Agents warned: ${warned.map(([id, n]) => `${id} (${n} calls)`).join(', ')}`,
    s.memoPath === null ? null : `Memo: ${s.memoPath}`,
  ]

  return lines.filter(l => l !== null).join('\n')
}

// The band above the prompt: a card with a status badge and the buttons, then
// one gauge per credit window.

const WINDOW_NAMES: Record<string, string> = { five_hour: 'Session 5h', seven_day: 'Week 7d', spend_limit: 'Spend' }
const windowName = (kind: string) => WINDOW_NAMES[kind] ?? kind
const windowRank = (kind: string) => {
  const rank = Object.keys(WINDOW_NAMES).indexOf(kind)

  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank
}

// The card's left column: the icon, then the mod's name in the header and
// each window's name under it, right-aligned on the mod's name; then a gap.
// The badge and the gauges start at the same column whatever width the
// terminal gives the icon.
const ICON_CELLS = 3
const NAME_CELLS = NAME.length
const LEFT_CELLS = ICON_CELLS + NAME_CELLS + 2
// Cells after the gauge for `  100 %`; the card's border and padding take 4.
const PERCENT_CELLS = 7
const CARD_CELLS = 4

// Colors as 0xRRGGBB: the gauge fades from green to amber to red as it nears
// the window's threshold, over a dark track.
const GREEN = 0x22c55e
const AMBER = 0xf59e0b
const RED = 0xef4444
const TRACK = 0x3a3a3a
const MARK = 0xd4d4d4
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

const mix = (from: number, to: number, t: number) => {
  const at = Math.min(1, Math.max(0, t))
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff

    return Math.round(a + (b - a) * at) << shift
  }

  return channel(16) | channel(8) | channel(0)
}

// The gauge's color at `percent`: green well below the threshold, amber 15
// points before it, red at it.
const gradientAt = (percent: number, threshold: number) => {
  const greenUntil = threshold - 35
  const amberAt = threshold - 15
  if (percent <= greenUntil) return GREEN
  if (percent <= amberAt) return mix(GREEN, AMBER, (percent - greenUntil) / (amberAt - greenUntil))

  return mix(AMBER, RED, (percent - amberAt) / (threshold - amberAt))
}

// Left-aligned blocks, one to seven eighths of a cell.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

type Cell = { glyph: string; fg: number; bg: number }

// The gauge's cells, filled to the eighth of a cell; an empty cell is a block
// in the track's color, and the threshold a thin mark on the track.
const gaugeCells = (percent: number, threshold: number, width: number): Cell[] => {
  const eighths = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width * 8)
  const mark = Math.min(width - 1, Math.round((threshold / 100) * width))

  return Array.from({ length: width }, (_, i) => {
    const fill = eighths - i * 8
    const color = gradientAt(((i + 0.5) / width) * 100, threshold)
    if (fill >= 8) return { glyph: '█', fg: color, bg: TRACK }
    if (fill > 0) return { glyph: EIGHTHS[fill] ?? '▏', fg: color, bg: TRACK }
    if (i === mark) return { glyph: '▏', fg: MARK, bg: TRACK }

    return { glyph: '█', fg: TRACK, bg: TRACK }
  })
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const toBase64 = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += (BASE64[(n >> 18) & 63] ?? '') + (BASE64[(n >> 12) & 63] ?? '')
    out += i + 1 < bytes.length ? (BASE64[(n >> 6) & 63] ?? '') : '='
    out += i + 2 < bytes.length ? (BASE64[n & 63] ?? '') : '='
  }

  return out
}

// A Raster's cells: little-endian u32 triplets [code point, foreground, background].
const rasterCells = (cells: readonly Cell[]) => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((c, i) => words.set([c.glyph.codePointAt(0) ?? 0x20, c.fg, c.bg], i * 3))

  return toBase64(new Uint8Array(words.buffer))
}

type Run = { text: string; fg: number; bg: number }

// The same cells as text runs, for a surface without Raster.
const textRuns = (cells: readonly Cell[]) =>
  cells.reduce<Run[]>((runs, c) => {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.fg === c.fg && last.bg === c.bg) last.text += c.glyph
    else runs.push({ text: c.glyph, fg: c.fg, bg: c.bg })

    return runs
  }, [])

type Gauge = { name: string; cells: Cell[]; color: string; percent: string; tail: string }

// Each window as a gauge sized to the card; a reading whose reset time has
// passed is drawn empty, as the next answer will read it.
const gaugesOf = (cfg: Config, windows: readonly SessionRateLimit[], columns: number, now: number): Gauge[] =>
  [...windows]
    .sort((a, b) => windowRank(a.kind) - windowRank(b.kind))
    .map(w => {
      const threshold = thresholdOf(cfg, w.kind)
      const resetsAt = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
      const isReset = resetsAt <= now
      const percent = isReset ? 0 : w.percentUsed
      const said = isReset
        ? `↻ reset since ${clockOf(resetsAt, now)}`
        : Number.isNaN(resetsAt) ? '' : `↻ ${clockOf(resetsAt, now)} · ${remainingOf(resetsAt - now)}`
      const room = columns - CARD_CELLS - LEFT_CELLS - PERCENT_CELLS
      const width = Math.max(1, Math.min(gaugeSpan(cfg), room))
      const tail = said === '' || room - width < said.length + 3 ? '' : `   ${said}`

      return {
        name: windowName(w.kind),
        cells: gaugeCells(percent, threshold, width),
        color: hex(gradientAt(percent, threshold)),
        percent: `${String(Math.round(percent)).padStart(5)} %`,
        tail,
      }
    })

// This session's reading: the one its last measure wrote, else the engine's
// (a measure is raised only once a window moves a whole point), else the last
// one kept, which the band says is old.
async function readCredit($: Engine): Promise<{ reading: GracefulStopCredit | null; isKept: boolean }> {
  const measured = await read($, credit)
  if (measured !== null) return { reading: measured, isKept: false }
  const live = (await $.session.usage()).rateLimits
  if (live.length > 0) return { reading: { windows: [...live], at: await $.clock.now() }, isKept: false }
  const windows = await $.store.get(CREDIT_KEY).catch(() => undefined)
  const at = await $.store.get(CREDIT_AT_KEY).catch(() => undefined)
  if (!Array.isArray(windows) || windows.length === 0) return { reading: null, isKept: false }

  return { reading: { windows: windows as SessionRateLimit[], at: typeof at === 'number' ? at : NaN }, isKept: true }
}

// The status badge: its word and colors, by phase.
const BADGES: Record<GracefulStopStatus['phase'], { word: string; fg: string; bg: string }> = {
  armed: { word: 'ARMED', fg: '#86efac', bg: '#14532d' },
  off: { word: 'OFF', fg: '#d4d4d8', bg: '#3f3f46' },
  stopping: { word: 'STOPPING', fg: '#fcd34d', bg: '#78350f' },
  overage: { word: 'OVERAGE', fg: '#fdba74', bg: '#7c2d12' },
  stopped: { word: 'STOPPED', fg: '#fca5a5', bg: '#7f1d1d' },
  braked: { word: 'BRAKED', fg: '#fca5a5', bg: '#7f1d1d' },
}

// The settings, beside the badge while the mod is armed.
const thresholdsPart = (cfg: Config) =>
  `clean stop at ${cfg.sessionThreshold} % (5h) · ${cfg.weeklyThreshold} % (7d)`
const settingsText = (cfg: Config) =>
  `${thresholdsPart(cfg)} · overage budget ${usd(cfg.budgetUsd)} · ${cfg.graceCalls} grace calls`

// The gauges span the armed header from the badge's left edge to the `·`
// after the thresholds: the badge, the space before the detail, the
// thresholds, then ` ·`.
const gaugeSpan = (cfg: Config) => badgeText('armed').length + 1 + thresholdsPart(cfg).length + 2

const badgeText = (phase: GracefulStopStatus['phase']) => ` ● ${BADGES[phase].word} `

const phaseDetail = (cfg: Config, s: GracefulStopStatus, back: string | null) => {
  const whenBack = back === null ? 'credit is back' : `credit back ${back}`
  switch (s.phase) {
    case 'armed':
      return settingsText(cfg)
    case 'off':
      return 'off for this session'
    case 'stopping':
      return `clean stop under way (${s.trigger}) · ${Object.keys(s.warned).length} agent(s) warned`
    case 'overage':
      return `clean stop in overage · ${usd(s.spentUsd)} of ${usd(cfg.budgetUsd)}`
    case 'braked':
      return `overage budget used up · ${whenBack}`
    case 'stopped':
      return `stopped cleanly · ${whenBack}`
  }
}

async function tick($: Engine) {
  const now = Math.floor((await $.clock.now()) / 60_000)
  await update($, minute, () => now)
}

// The band's Off / On button: the same as `/graceful-stop off|on`.
async function toggle($: Engine) {
  await update($, status, s => (s.phase === 'off' ? ARMED : OFF))
}

// The band's Resume button: the command's resume, said in a toast.
async function pressResume($: Engine, cfg: Config, isWorking: boolean) {
  const said = isWorking ? 'Claude is working: resume once the turn has ended.' : await resume($, cfg)
  $.ui.toast(`${NAME}: ${said}`)
}

type PanelOptions = {
  /** Cells the card may take. */
  columns: number
  /** Whether a model turn is running: Resume waits for it. */
  isWorking: boolean
  /** What a command just did, shown under the header; null for the panel. */
  notice: string | null
}

// The mod's card, drawn above the prompt and as its command's output: its
// state, a gauge per credit window, its settings, Off / On and Resume.
async function drawPanel($: Engine, cfg: Config, e: ResolveInput, o: PanelOptions) {
  const s = await read($, status)
  await read($, minute)
  const { reading, isKept } = await readCredit($)
  const now = await $.clock.now()
  const back = await creditBack($, cfg)
  const canResume = !isWatching(s) && !o.isWorking && back === null
  const gauges = gaugesOf(cfg, reading?.windows ?? [], o.columns, now)
  const badge = BADGES[s.phase]

  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  // Raster paints each cell's colors: the terminal's alone (another surface's
  // table may hold it as a fragment that draws nothing).
  const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={CARD_BORDER} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" flexShrink={1}>
          <Box width={ICON_CELLS} flexShrink={0}>
            <Text color={MOD_COLOR} bold>⏹</Text>
          </Box>
          <Box width={LEFT_CELLS - ICON_CELLS} flexShrink={0}>
            <Text color={MOD_COLOR} bold>{NAME}</Text>
          </Box>
          <Text color={badge.fg} backgroundColor={badge.bg} bold>{badgeText(s.phase)}</Text>
          <Text dimColor wrap="truncate">{` ${phaseDetail(cfg, s, isHalted(s) ? back : null)}`}</Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} gap={1}>
          <Button key="toggle" hotkey="o" onPress={() => toggle($)}>
            {s.phase === 'off' ? 'On' : 'Off'}
          </Button>
          <Button
            key="resume"
            hotkey="r"
            variant={canResume ? 'primary' : 'secondary'}
            dimColor={!canResume}
            onPress={() => pressResume($, cfg, o.isWorking)}
          >
            Resume
          </Button>
        </Box>
      </Box>
      {o.notice !== null && (
        <Text key="notice" wrap="wrap">{`› ${o.notice}`}</Text>
      )}
      <Box height={1} />
      {gauges.map(g => (
        <Box key={`gauge-${g.name.trim()}`} flexDirection="row">
          <Box width={ICON_CELLS} flexShrink={0} />
          <Box width={NAME_CELLS} flexShrink={0} justifyContent="flex-end">
            <Text bold>{g.name}</Text>
          </Box>
          <Box width={LEFT_CELLS - ICON_CELLS - NAME_CELLS} flexShrink={0} />
          {Raster !== null ? (
            <Raster key={`bar-${g.name.trim()}`} columns={g.cells.length} rows={1} cells={rasterCells(g.cells)} />
          ) : (
            textRuns(g.cells).map((r, i) => (
              <Text key={`run-${i}`} color={hex(r.fg)} backgroundColor={hex(r.bg)}>
                {r.text}
              </Text>
            ))
          )}
          <Text color={g.color} bold>{g.percent}</Text>
          <Text dimColor wrap="truncate">{g.tail}</Text>
        </Box>
      ))}
      {reading === null && (
        <Text dimColor wrap="truncate">No credit reading yet: it comes with the first answer.</Text>
      )}
      {isKept && reading !== null && (
        <Text dimColor wrap="truncate">
          {`Last reading ${Number.isNaN(reading.at) ? 'from an earlier session' : `at ${clockOf(reading.at, now)}`}: it refreshes with the first answer.`}
        </Text>
      )}
      {s.memoPath !== null && s.phase !== 'armed' && s.phase !== 'off' && (
        <Text dimColor wrap="truncate">{`Memo  ${s.memoPath}`}</Text>
      )}
    </Box>
  )
}

// `/graceful-stop <args>` and `/gs <args>`.
async function runCommand($: Engine, cfg: Config, args: string) {
  const arg = args.trim().toLowerCase() || 'status'

  if (arg === 'stop') {
    const top = peakOf((await $.session.usage()).rateLimits)
    await update($, status, s => (s.phase === 'off' ? ARMED : s))
    await startStop($, cfg, top, `manual (${describeWindow(top)})`)
    const s = await read($, status)

    return { text: `Clean stop: ${s.phase}${s.memoPath === null ? '' : `, memo ${s.memoPath}`}.` }
  }
  if (arg === 'resume') {
    return { text: await resume($, cfg) }
  }
  if (arg === 'on') {
    await update($, status, () => ARMED)

    return { text: `Re-armed: the clean stop will start at ${thresholdsText(cfg)}.` }
  }
  if (arg === 'off') {
    await update($, status, () => OFF)

    return { text: `Off for this session. /${NAME} on to re-arm.` }
  }

  return { text: await statusText($, cfg) }
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    sessionThreshold: Number(options.sessionThreshold ?? 90),
    weeklyThreshold: Number(options.weeklyThreshold ?? 95),
    budgetUsd: Number(options.overageBudgetUsd ?? 2),
    graceCalls: Math.max(0, Math.floor(Number(options.graceToolCalls ?? 5))),
    armAtStart: options.armAtStart !== false,
  }
  const isOpen = options.showSettings === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Wind agents down cleanly before the session credit runs out',
      argumentHint: '[status|stop|resume|on|off]',
      immediate: true,
    })
    await $.command.register({
      name: ALIAS,
      description: `Short for /${NAME}`,
      argumentHint: '[status|stop|resume|on|off]',
      immediate: true,
    })
    // A change of the toggle reloads the module: redraw the rows it folds.
    $.ui.invalidate('config.describe')
    // A reload starts the session over for the module, not for the person.
    if (!(await read($, started))) {
      await update($, started, () => true)
      if (!cfg.armAtStart) await update($, status, s => (s.phase === 'armed' ? OFF : s))
    }
    await tick($)
    $.clock.every(60_000, () => void tick($))

    return next(e)
  })

  on('config.describe', async ($, e, next) => {
    if (!e.key.startsWith(`${NAME}.`)) return next(e)
    const row = await next(e)
    if (e.key === TOGGLE_KEY) {
      return {
        ...row,
        label: `${isOpen ? '▾' : '▸'} ${NAME}`,
        description: isOpen ? `Hide the ${NAME} settings.` : `Show the ${NAME} settings.`,
      }
    }

    return isOpen ? row : { ...row, isHidden: true }
  })

  on('session.measure', async ($, e, next) => {
    const top = peakOf(e.rateLimits)
    const crossed = crossedWindow(cfg, e.rateLimits)
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const at = await $.clock.now()
      await update($, credit, () => ({ windows: [...e.rateLimits], at }))
      await $.store.set(CREDIT_KEY, e.rateLimits).catch(() => undefined)
      await $.store.set(CREDIT_AT_KEY, at).catch(() => undefined)
    }

    if (crossed !== null) {
      await startStop($, cfg, crossed, describeWindow(crossed))
    }
    if (top !== null && top.percentUsed >= 100) {
      await update($, status, (s): GracefulStopStatus =>
        s.phase === 'stopping' ? { ...s, phase: 'overage', baselineUsd: e.cost?.usd ?? 0 } : s,
      )
    }
    await checkBudget($, cfg, e.cost?.usd)

    return next(e)
  })

  on('turn.start', (_$, e, next) => {
    isMainBusy = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      if (isWatching(await read($, status))) await recordReport($, e.agentId, e.answer, 'completed')

      return next(e)
    }
    isMainBusy = false
    const s = await read($, status)
    if (isWatching(s) && (await activeAgents($)).length === 0) await settleMainTurn($, cfg, s)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const s = await read($, status)
    if (isHalted(s)) {
      const text = await haltMessage($, cfg, s)
      yield { kind: 'text' as const, index: 0, text }

      return {
        turnId: e.turnId,
        index: e.index,
        answer: text,
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: null,
      }
    }

    const result = yield* next(e)
    if (isWatching(await read($, status))) {
      await checkBudget($, cfg, (await $.session.usage()).cost?.usd)
    }

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const s = await read($, status)

    return s.phase === 'armed' || s.phase === 'off' ? next(e) : { deny: SPAWN_DENIED }
  })

  on('tool.call', async ($, e, next) => {
    const s = await read($, status)
    if (e.agentId !== undefined && String(e.tool) === HANDBACK_TOOL) {
      const report = handbackText(e)
      if (isWatching(s) && report !== null) await recordReport($, e.agentId, report, 'reporting')

      return next(e)
    }
    if (isHalted(s)) return { deny: await haltMessage($, cfg, s) }
    if (!isWatching(s) || e.agentId === undefined) return next(e)

    const id = e.agentId
    const used = s.warned[id]
    if (used === undefined) {
      await adoptAgent($, id)
      await warnAgent($, cfg, id, s.trigger ?? 'threshold reached')
    }
    await update($, status, cur => ({
      ...cur,
      warned: { ...cur.warned, [id]: (cur.warned[id] ?? 0) + 1 },
    }))

    return (used ?? 0) >= cfg.graceCalls ? { deny: AGENT_CUTOFF } : next(e)
  })

  for (const command of COMMANDS) {
    on('command.run', { command }, async ($, e) => runCommand($, cfg, e.args))
  }

  // The mod's notes to the orchestrator and its agents: user-role rows.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (!isModText(e.props.text)) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={MOD_COLOR} paddingX={1}>
        <Text color={MOD_COLOR} bold>{MOD_LABEL}</Text>
        <Text color={MOD_COLOR} wrap="wrap">{modBody(e.props.text)}</Text>
      </Box>
    )
  })

  // The brake's answers: they read as a reply, yet no model wrote them.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!isModText(e.props.text)) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text color={MOD_COLOR} bold>{MOD_LABEL}</Text>
        <Text color={MOD_COLOR} wrap="wrap">{modBody(e.props.text)}</Text>
      </Box>
    )
  })

  // The command's output is the mod's card, with what the command did on top;
  // the model still reads the text.
  for (const command of COMMANDS) {
    on('ui.render', { component: 'CommandOutput', props: { command } }, async ($, e, next) => {
      if (e.props.isErrored) return next(e)
      const isStatus = ['', 'status'].includes(e.props.args.trim().toLowerCase())

      return drawPanel($, cfg, e, {
        columns: (e.viewport?.columns ?? 100) - 2,
        isWorking: isMainBusy,
        notice: isStatus ? null : modBody(e.props.text),
      })
    })
  }

  // The same card above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    return drawPanel($, cfg, e, { columns: e.props.bodyColumns, isWorking: e.props.isWorking, notice: null })
  })
}
