import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { CleanEndAgent, CleanEndStatus } from '../types'

const NAME = 'clean-end-of-session'
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

const ARMED: CleanEndStatus = {
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

const status = atom({ plugin: 'clean-end-of-session', key: 'status' } as const, ARMED)

type Engine = EngineInterface
type Config = {
  /** Trigger for the 5-hour session window, in percent. */
  sessionThreshold: number
  /** Trigger for the 7-day window: its last few percent are about one whole session. */
  weeklyThreshold: number
  budgetUsd: number
  graceCalls: number
}

// Whether the main loop is in a turn; a reload forgets it, which only means
// the next clean stop may judge the session idle and write no memo.
let isMainBusy = false

const isWatching = (s: CleanEndStatus) => s.phase === 'stopping' || s.phase === 'overage'
const isHalted = (s: CleanEndStatus) => s.phase === 'stopped' || s.phase === 'braked'

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

const toRecord = (a: AgentInfo): CleanEndAgent => ({
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
  `3) the exact next step to resume; 4) anything to watch out for.`

const AGENT_CUTOFF =
  `${TAG} Tools cut off: the session credit is almost used up. Call no more tools. Write your ` +
  `final answer now as a status report (done / half done with files / next step / watch-outs).`

// Everything the mod says in the conversation is drawn in this colour, under
// this label, so it never reads as the agent's own work.
const MOD_COLOR = 'yellow'
const MOD_LABEL = `⏹ ${NAME}`

const isModText = (text: string) => text.trimStart().startsWith(TAG)

// The message without its tag, or a command's output without the plugin name
// the engine prints before it.
const modBody = (text: string) => {
  const body = text.trimStart()
  const prefix = [TAG, `${NAME}:`].find(p => body.startsWith(p)) ?? ''

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
  `step / files), decisions made, and how to resume. Then stop. Past 100% of the credit, paid ` +
  `overage of at most ${usd(cfg.budgetUsd)} is allowed for this clean stop only: be concise.`

const haltText = (cfg: Config, s: CleanEndStatus) => {
  const why =
    s.phase === 'braked'
      ? `Overage budget used up (${usd(s.spentUsd)} of ${usd(cfg.budgetUsd)}).`
      : `Session stopped cleanly (${s.trigger ?? 'threshold reached'}).`
  const memo = s.memoPath === null ? '' : ` Resume memo: ${s.memoPath}.`

  return (
    `${TAG} ${why}${memo} No request was sent to the model. ` +
    `/${NAME} reset to resume once the credit is back, /${NAME} off to ignore the threshold.`
  )
}

async function activeAgents($: Engine) {
  return (await $.agent.list()).filter(a => ACTIVE_AGENT.has(a.status))
}

const agentSection = (a: CleanEndAgent) => [
  `### ${a.description}`,
  '',
  `- Type: ${a.type}`,
  `- Status: ${a.status}`,
  `- Id: \`${a.id}\``,
  '',
  a.report === null ? '_No status report received._' : a.report.trim(),
  '',
]

async function fallbackMemo($: Engine, s: CleanEndStatus) {
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
async function writeFallback($: Engine, s: CleanEndStatus) {
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

async function startStop($: Engine, cfg: Config, top: SessionRateLimit | null, trigger: string) {
  if ((await read($, status)).phase !== 'armed') return

  const agents = await activeAgents($)
  const hasWork = agents.length > 0 || isMainBusy
  const memoPath = hasWork
    ? joinPath(await memoDir($), `CLEAN-END-OF-SESSION_${stamp(await $.clock.now())}.md`)
    : null
  const stop: CleanEndStatus = {
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
    $.ui.toast(`${NAME}: ${trigger}, nothing running. No more requests will leave.`)
    return
  }

  await writeFallback($, stop)
  await Promise.all(agents.map(a => warnAgent($, cfg, a.id, trigger)))
  await warnMain($, mainNote(cfg, trigger, agents.length, memoPath))
  $.ui.toast(`${NAME}: ${trigger}, clean stop of ${agents.length} agent(s) started.`)
}

// Keeps an agent the stop did not see at its start (spawned just before it).
async function adoptAgent($: Engine, id: string) {
  const found = (await $.agent.list()).find(a => a.id === id)
  const record: CleanEndAgent = found === undefined
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
async function settleMainTurn($: Engine, s: CleanEndStatus) {
  const isWritten = s.memoPath === null || (await isMemoReplaced($, s.memoPath))
  if (isWritten || s.idleTurns + 1 >= MAX_IDLE_TURNS) {
    await halt($, 'stopped')
    return
  }
  await update($, status, cur => (isWatching(cur) ? { ...cur, idleTurns: cur.idleTurns + 1 } : cur))
}

async function halt($: Engine, phase: 'stopped' | 'braked') {
  await update($, status, s => (isWatching(s) ? { ...s, phase } : s))
  const s = await read($, status)
  if (s.phase !== phase) return
  await writeFallback($, s)
  $.ui.toast(
    phase === 'braked'
      ? `${NAME}: overage budget used up, no more requests leave.`
      : `${NAME}: clean stop complete.`,
  )
}

async function checkBudget($: Engine, cfg: Config, costUsd: number | undefined) {
  const s = await read($, status)
  if (s.phase !== 'overage' || s.baselineUsd === null || costUsd === undefined) return
  const spent = Math.max(0, costUsd - s.baselineUsd)
  await update($, status, cur => (cur.phase === 'overage' ? { ...cur, spentUsd: spent } : cur))
  if (spent >= cfg.budgetUsd) await halt($, 'braked')
}

async function statusText($: Engine, cfg: Config) {
  const s = await read($, status)
  const usage = await $.session.usage()
  const windows = usage.rateLimits.map(w => `${w.kind} ${w.percentUsed}%`).join(', ') || 'no reading yet'
  const warned = Object.entries(s.warned)
  const lines = [
    `Phase: ${s.phase} (thresholds ${thresholdsText(cfg)}, overage budget ${usd(cfg.budgetUsd)}, grace ${cfg.graceCalls} calls)`,
    `Credit: ${windows}`,
    s.trigger === null ? null : `Trigger: ${s.trigger}`,
    s.phase === 'overage' || s.phase === 'braked' ? `Estimated overage: ${usd(s.spentUsd)}` : null,
    warned.length === 0 ? null : `Agents warned: ${warned.map(([id, n]) => `${id} (${n} calls)`).join(', ')}`,
    s.memoPath === null ? null : `Memo: ${s.memoPath}`,
  ]

  return lines.filter(l => l !== null).join('\n')
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    sessionThreshold: Number(options.sessionThreshold ?? 90),
    weeklyThreshold: Number(options.weeklyThreshold ?? 95),
    budgetUsd: Number(options.overageBudgetUsd ?? 2),
    graceCalls: Math.max(0, Math.floor(Number(options.graceToolCalls ?? 5))),
  }
  const isOpen = options.showSettings === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Wind agents down cleanly before the session credit runs out',
      argumentHint: '[status|stop|reset|off|on]',
      immediate: true,
    })
    // A change of the toggle reloads the module: redraw the rows it folds.
    $.ui.invalidate('config.describe')

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

    if (crossed !== null) {
      await startStop($, cfg, crossed, describeWindow(crossed))
    }
    if (top !== null && top.percentUsed >= 100) {
      await update($, status, (s): CleanEndStatus =>
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
    if (isWatching(s) && (await activeAgents($)).length === 0) await settleMainTurn($, s)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const s = await read($, status)
    if (isHalted(s)) {
      const text = haltText(cfg, s)
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
    if (isHalted(s)) return { deny: haltText(cfg, s) }
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

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim().toLowerCase() || 'status'

    if (arg === 'stop') {
      const top = peakOf((await $.session.usage()).rateLimits)
      await update($, status, s => (s.phase === 'off' ? ARMED : s))
      await startStop($, cfg, top, `manual (${describeWindow(top)})`)
      const s = await read($, status)

      return { text: `Clean stop: ${s.phase}${s.memoPath === null ? '' : `, memo ${s.memoPath}`}.` }
    }
    if (arg === 'reset' || arg === 'on') {
      await update($, status, () => ARMED)

      return { text: `Re-armed: the clean stop will start at ${thresholdsText(cfg)}.` }
    }
    if (arg === 'off') {
      await update($, status, () => ({ ...ARMED, phase: 'off' as const }))

      return { text: `Off for this session. /${NAME} on to re-arm.` }
    }

    return { text: await statusText($, cfg) }
  })

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

  on('ui.render', { component: 'CommandOutput', props: { command: NAME } }, ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {modBody(e.props.text)
          .split('\n')
          .map((line, i) => (
            <Text key={`line-${i}`} color={MOD_COLOR} wrap="wrap">
              {line}
            </Text>
          ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, status)
    if (e.props.hasSurvey || s.phase === 'armed' || s.phase === 'off') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const label =
      s.phase === 'stopping'
        ? `Clean stop under way (${s.trigger}) · ${Object.keys(s.warned).length} agent(s) warned`
        : s.phase === 'overage'
          ? `Clean stop in overage: ${usd(s.spentUsd)} / ${usd(cfg.budgetUsd)}`
          : s.phase === 'braked'
            ? `Overage budget used up · /${NAME} reset to resume`
            : `Session stopped cleanly · /${NAME} reset to resume`

    return (
      <Box flexDirection="column">
        <Text color={MOD_COLOR} bold={isHalted(s)} wrap="truncate">
          {`${NAME} · ${label}`}
        </Text>
        {s.memoPath !== null && (
          <Text color={MOD_COLOR} dimColor wrap="truncate">
            {`Memo: ${s.memoPath}`}
          </Text>
        )}
      </Box>
    )
  })
}
