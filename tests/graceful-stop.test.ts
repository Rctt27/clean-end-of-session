import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On, SessionRateLimit } from 'claude-code'

const AGENT: AgentInfo = {
  id: 'agent-1',
  description: 'Refactor billing',
  type: 'general-purpose',
  status: 'running',
}

const RESETS_AT = '2026-10-06T18:00:00Z'
// 2 h 13 before the session window resets.
const NOW = Date.parse(RESETS_AT) - (2 * 60 + 13) * 60_000

type World = {
  notes: { agentId?: string; text: string }[]
  files: Map<string, string>
  usd: { value: number }
  requests: { value: number }
  prompts: string[]
  toasts: string[]
  limits: SessionRateLimit[]
  clock: MockClock
}

// The engine beneath the plugin: agents, files, usage, appends and requests.
type Where = {
  root?: string
  repo?: string | null
  /** What the session's usage reads, the last measure's by default. */
  limits?: SessionRateLimit[]
  /** What the mod's store holds at the start. */
  store?: Record<string, unknown>
}

// Paths reach fs resolved by the engine (`C:\proj` on Windows): files are kept
// under one spelling.
const norm = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
const dirOf = (path: string) => norm(path).replace(/\/[^/]*$/, '')

function world(on: On, agents: AgentInfo[], where: Where = {}): World {
  const w: World = {
    notes: [],
    files: new Map(),
    usd: { value: 10 },
    requests: { value: 0 },
    prompts: [],
    toasts: [],
    limits: where.limits ?? [{ kind: 'five_hour', percentUsed: 90, resetsAt: RESETS_AT }],
    clock: mock.clock(on, { now: NOW }),
  }
  mock.store(on, where.store)
  on('session.measure', (_$, e) => {
    if (where.limits === undefined && e.rateLimits.length > 0) w.limits = [...e.rateLimits]

    return { changed: e.changed }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: agents }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.root', () => ({ value: where.root ?? '/proj' }))
  on('session.repo', () => {
    const root = where.repo === undefined ? '/proj' : where.repo

    return { value: root === null ? null : { root, remote: null, internal: false, name: null } }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: w.limits,
      cost: { usd: w.usd.value },
    },
  }))
  on('fs.exists', (_$, e) => ({ value: w.files.has(norm(e.path)) }))
  on('fs.read', (_$, e) => ({ value: w.files.get(norm(e.path)) ?? '' }))
  on('fs.write', (_$, e) => {
    w.files.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: [...w.files.keys()]
      .filter(path => dirOf(path) === norm(e.path))
      .map(path => ({ name: path.slice(dirOf(path).length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e.text)

    return { text: e.text }
  })
  // The kit skips an append hook that answers without `next`, so the row is
  // recorded on its way down and the plugin falls back to `session.send`.
  on('session.append', (_$, e, next) => {
    const block = e.message.content[0]
    w.notes.push({ agentId: e.agentId, text: block?.type === 'text' ? String(block.text) : '' })

    return next(e)
  })
  on('session.send', (_$, e) => {
    w.notes.push({ agentId: e.to, text: e.text })

    return { isDelivered: true }
  })
  on('turn.step', async function* (_$, e) {
    w.requests.value += 1
    yield { kind: 'text' as const, index: 0, text: 'ok' }

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)

  return w
}

const measure = (percentUsed: number, usd: number) => ({
  context: { window: 200000 },
  rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: RESETS_AT }],
  cost: { usd },
  changed: ['rateLimits' as const],
})

const bash = (agentId?: string) => ({
  tool: 'Bash' as const,
  tool_use_id: `call-${Math.random()}`,
  command: 'ls',
  ...(agentId === undefined ? {} : { agentId }),
})

async function step($: Engine, agentId?: string) {
  let answer = ''
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId })) {
    if (chunk.kind === 'text') answer += chunk.text
  }

  return answer
}

test('below the threshold nothing happens', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(89, 10))

  expect(w.notes).toEqual([])
  expect(w.files.size).toBe(0)
})

test('at the threshold agents and the orchestrator are warned and a memo is laid', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(90, 10))

  expect(w.notes.find(n => n.agentId === 'agent-1')?.text).toMatch(/status report/)
  expect(w.notes.find(n => n.agentId !== 'agent-1')?.text).toMatch(/resume memo/)
  const [path, memo] = [...w.files.entries()][0] ?? []
  expect(path).toMatch(/GRACEFUL-STOP_.*\.md$/)
  expect(memo).toMatch(/Refactor billing/)
})

test('no new agent is spawned once the stop started', async ($, on) => {
  world(on, [AGENT])
  await $.session.measure(measure(90, 10))
  const spawned = await $.agent.spawn({
    tool_use_id: 'spawn-1',
    prompt: 'more work',
    description: 'More work',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })

  expect('deny' in spawned && spawned.deny).toMatch(/Spawn refused/)
})

test('a subagent keeps its grace calls, then its tools are cut off', async ($, on) => {
  world(on, [AGENT])
  await $.session.measure(measure(90, 10))

  for (let i = 0; i < 5; i += 1) {
    const ran = await $.tool.call(bash('agent-1'))
    expect(ran.deny).toBeUndefined()
  }
  const cut = await $.tool.call(bash('agent-1'))
  expect(cut.deny ?? cut.text).toMatch(/Tools cut off/)

  const main = await $.tool.call(bash())
  expect(main.deny).toBeUndefined()
})

test('past 100% the overage budget is spent, then no request leaves', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(90, 10))
  await $.session.measure(measure(100, 10))

  w.usd.value = 11
  expect(await step($, 'agent-1')).toBe('ok')
  expect(w.requests.value).toBe(1)

  w.usd.value = 12.5
  await step($, 'agent-1')
  expect(w.requests.value).toBe(2)

  expect(await step($)).toMatch(/Overage budget used up/)
  expect(w.requests.value).toBe(2)
  expect([...w.files.values()][0]).toMatch(/braked/)
})

test('the orchestrator memo is never overwritten by the fallback', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(90, 10))
  const [path] = [...w.files.keys()]
  w.files.set(path ?? '', '# Real memo')
  await $.session.measure(measure(100, 10))
  w.usd.value = 13
  await step($, 'agent-1')

  expect(w.files.get(path ?? '')).toBe('# Real memo')
})

const command = async ($: Engine, args: string, name = 'graceful-stop') =>
  (
    await $.command.run({
      command: name,
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    } as never)
  ).text ?? ''

test('off keeps everything running, on re-arms', async ($, on) => {
  const w = world(on, [AGENT])
  await command($, 'off')
  await $.session.measure(measure(95, 10))
  expect(w.notes).toEqual([])

  await command($, 'on')
  await $.session.measure(measure(96, 10))
  expect(w.notes.length).toBe(2)
})

const agentDone = (id: string) => ({
  answer: `Status report of ${id}: listed the root, nothing else done.`,
  durationMs: 1000,
  isAborted: false,
  turnId: `turn-${id}`,
  agentId: id,
  reason: 'answer' as const,
})

const mainDone = (turnId: string) => ({
  answer: 'waiting for the other reports',
  durationMs: 1000,
  isAborted: false,
  turnId,
  reason: 'answer' as const,
})

const three = (): AgentInfo[] =>
  ['imagimots', 'so-clover', 'talent-manager'].map(id => ({ ...AGENT, id, description: `Analyse ${id}` }))

test('the test run: reports landing after an orchestrator turn still reach the memo', async ($, on) => {
  const agents = three()
  const w = world(on, agents)
  await $.session.measure(measure(90, 10))

  // All three agents finish, each handing back its status report.
  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i]
    if (agent === undefined) continue
    agents[i] = { ...agent, status: 'completed' }
    await $.turn.complete(agentDone(agent.id))
  }
  // The orchestrator ends a turn without writing the memo: the stop goes on.
  await $.turn.complete(mainDone('main-1'))
  expect(await step($)).toBe('ok')

  const [path, memo] = [...w.files.entries()][0] ?? ['', '']
  for (const id of ['imagimots', 'so-clover', 'talent-manager']) {
    expect(memo).toMatch(`### Analyse ${id}`)
    expect(memo).toMatch(`Status report of ${id}`)
  }
  expect(memo).toMatch(/Status: completed/)

  // It then writes the memo: the next orchestrator turn ends the stop.
  w.files.set(path, '# Real memo')
  await $.turn.complete(mainDone('main-2'))
  expect(await step($)).toMatch(/Session stopped cleanly/)
  expect(w.files.get(path)).toBe('# Real memo')
})

test('the stop ends anyway after two orchestrator turns that write no memo', async ($, on) => {
  const agents = three()
  world(on, agents)
  await $.session.measure(measure(90, 10))
  agents.splice(0, agents.length)

  await $.turn.complete(mainDone('main-1'))
  expect(await step($)).toBe('ok')
  await $.turn.complete(mainDone('main-2'))
  expect(await step($)).toMatch(/Session stopped cleanly/)
})

const handback = (agentId: string, message: string) =>
  ({ tool: 'SubagentHandback', tool_use_id: `handback-${agentId}`, message, agentId }) as never

test('a hand-back report reaches the memo and is never cut off', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await $.session.measure(measure(90, 10))
  for (let i = 0; i < 6; i += 1) await $.tool.call(bash('agent-1'))

  const handed = await $.tool.call(handback('agent-1', 'Report: listed the root, nothing else.'))
  expect(handed.deny).toBeUndefined()

  // Its final answer is empty: the hand-back report stays.
  agents[0] = { ...AGENT, status: 'completed' }
  await $.turn.complete({ ...agentDone('agent-1'), answer: '' })
  const memo = [...w.files.values()][0] ?? ''
  expect(memo).toMatch('Report: listed the root, nothing else.')
  expect(memo).toMatch(/Status: completed/)
})

test('the memo goes to the root of the repository the session works in', async ($, on) => {
  const w = world(on, [AGENT], { root: '/proj/src/api', repo: '/proj' })
  await $.session.measure(measure(90, 10))

  const [path] = [...w.files.keys()]
  expect(path).toMatch(/proj[\\/]GRACEFUL-STOP_/)
})

test('outside a repository the memo goes to the session root', async ($, on) => {
  const w = world(on, [AGENT], { root: '/work/notes', repo: null })
  await $.session.measure(measure(90, 10))

  const [path] = [...w.files.keys()]
  expect(path).toMatch(/notes[\\/]GRACEFUL-STOP_/)
})

const both = (session: number, weekly: number) => ({
  context: { window: 200000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: session, resetsAt: '2026-10-06T18:00:00Z' },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: '2026-10-10T17:00:00Z' },
  ],
  cost: { usd: 10 },
  changed: ['rateLimits' as const],
})

test('the weekly window waits for 95%, the session window for 90%', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(both(89, 94))
  expect(w.notes).toEqual([])

  await $.session.measure(both(60, 95))
  expect(w.notes.find(n => n.agentId === 'agent-1')?.text).toMatch(/seven_day at 95%/)
})

test('the session window triggers at 90% whatever the weekly one', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(both(90, 40))

  expect(w.notes.find(n => n.agentId === 'agent-1')?.text).toMatch(/five_hour at 90%/)
  expect([...w.files.values()][0]).toMatch(/Credit resets at: 2026-10-06T18:00:00Z/)
})

test('the thresholds follow the configuration', { options: { sessionThreshold: 80, weeklyThreshold: 99 } }, async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(both(79, 98))
  expect(w.notes).toEqual([])

  await $.session.measure(both(80, 98))
  expect(w.notes.length).toBeGreaterThan(0)
})

const describeRow = (field: string, label: string) => ({
  key: `graceful-stop.${field}`,
  label,
  isHidden: false,
  provider: { plugin: 'graceful-stop', tier: 'user' as const },
})

function menu(on: On) {
  on('config.describe', (_$, e) => ({ label: e.label, description: e.description, isHidden: e.isHidden }))
  on('ui.invalidate', () => ({ value: undefined }))
}

test('the settings fold under a closed chevron by default', async ($, on) => {
  menu(on)
  const toggle = await $.config.describe(describeRow('showSettings', 'graceful-stop'))
  const threshold = await $.config.describe(describeRow('sessionThreshold', 'graceful-stop · Session trigger threshold (%)'))
  const other = await $.config.describe({ ...describeRow('x', 'Theme'), key: 'theme' })

  expect(toggle.label).toBe('▸ graceful-stop')
  expect(threshold.isHidden).toBe(true)
  expect(other.isHidden).toBe(false)
})

test('an open chevron shows every setting, each led by the mod name', { options: { showSettings: true } }, async ($, on) => {
  menu(on)
  const toggle = await $.config.describe(describeRow('showSettings', 'graceful-stop'))
  const threshold = await $.config.describe(describeRow('sessionThreshold', 'graceful-stop · Session trigger threshold (%)'))

  expect(toggle.label).toBe('▾ graceful-stop')
  expect(threshold.isHidden).toBe(false)
  expect(threshold.label).toMatch(/^graceful-stop · /)
})

const BACK = /(today|tomorrow) \d\d:\d\d \(in 2 h 13\)/

// Stops the session with an agent at work and lets the stop run to its end.
async function stopCleanly($: Engine, w: World, agents: AgentInfo[]) {
  await $.session.measure(measure(90, 10))
  agents.splice(0, agents.length)
  await $.turn.complete(mainDone('main-1'))
  await $.turn.complete(mainDone('main-2'))
  const [path] = [...w.files.keys()]

  return path ?? ''
}

test('the brake and the status say when the credit is back', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await stopCleanly($, w, agents)

  expect(await step($)).toMatch(new RegExp(`Credit back ${BACK.source}: /graceful-stop resume`))
  expect(await command($, 'status')).toMatch(new RegExp(`Credit back: ${BACK.source}`))
})

test('resume is refused until the credit is reset', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await stopCleanly($, w, agents)

  const said = await command($, 'resume')
  await w.clock.advance(1)
  expect(said).toMatch(new RegExp(`^Your credits have not been reset yet\. Reset time: ${BACK.source}\.$`))
  expect(w.prompts).toEqual([])
  expect(await step($)).toMatch(/Session stopped cleanly/)
})

test('once the window reset, resume re-arms and relaunches the work from the memo', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  const memo = await stopCleanly($, w, agents)

  // The reading still says 90%, as no request left since: its reset time has passed.
  await w.clock.set(Date.parse(RESETS_AT) + 60_000)
  const said = await command($, 'resume')
  await w.clock.advance(1)

  expect(said).toMatch(/^Re-armed .* Resuming from .*GRACEFUL-STOP_.*\.md\.$/)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toMatch(/^\[graceful-stop\] The credit is back/)
  expect(norm(w.prompts[0] ?? '')).toContain(memo)
  expect(await step($)).toBe('ok')
})

test('the weekly window holds the resume after the session window reset', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents, {
    limits: [
      { kind: 'five_hour', percentUsed: 92, resetsAt: RESETS_AT },
      { kind: 'seven_day', percentUsed: 96, resetsAt: '2026-10-09T12:00:00Z' },
    ],
  })
  await stopCleanly($, w, agents)
  await w.clock.set(Date.parse(RESETS_AT) + 60_000)

  expect(await command($, 'resume')).toMatch(/not been reset yet\. Reset time: \w+ 9 Oct \d\d:\d\d \(in 2 d \d+ h\)/)
})

test('a fresh session resumes from the credit and memo kept by the last one', async ($, on) => {
  const kept = '/proj/GRACEFUL-STOP_2026-10-06_15h40.md'
  const w = world(on, [], {
    limits: [],
    store: {
      credit: [{ kind: 'five_hour', percentUsed: 93, resetsAt: RESETS_AT }],
      memoPath: kept,
    },
  })
  w.files.set(kept, '# Memo')

  expect(await command($, 'resume')).toMatch(/not been reset yet/)

  await w.clock.set(Date.parse(RESETS_AT) + 60_000)
  expect(await command($, 'resume')).toMatch(/Resuming from/)
  await w.clock.advance(1)
  expect(norm(w.prompts[0] ?? '')).toContain(kept)
})

test('without a kept memo, resume takes the newest at the repository root', async ($, on) => {
  const w = world(on, [], { limits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: RESETS_AT }] })
  w.files.set('/proj/GRACEFUL-STOP_2026-10-01_09h00.md', '# Older')
  w.files.set('/proj/GRACEFUL-STOP_2026-10-05_21h30.md', '# Newer')
  w.files.set('/proj/README.md', '# Readme')

  expect(await command($, 'resume')).toMatch(/2026-10-05_21h30\.md\.$/)
})

test('a memo written under the old name is still resumed from', async ($, on) => {
  const w = world(on, [], { limits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: RESETS_AT }] })
  w.files.set('/proj/CLEAN-END-OF-SESSION_2026-10-05_21h30.md', '# Old memo')

  expect(await command($, 'resume')).toMatch(/CLEAN-END-OF-SESSION_2026-10-05_21h30\.md\.$/)
})

test('with no memo at all, resume says so and changes nothing', async ($, on) => {
  const w = world(on, [], { limits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: RESETS_AT }] })
  await command($, 'off')

  expect(await command($, 'resume')).toMatch(/^No resume memo found in .*proj\. \/graceful-stop on re-arms/)
  await w.clock.advance(1)
  expect(w.prompts).toEqual([])
  expect(await command($, 'status')).toMatch(/^Phase: off/)
})

test('resume waits for a clean stop under way to end', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(90, 10))
  await w.clock.set(Date.parse(RESETS_AT) + 60_000)

  expect(await command($, 'resume')).toMatch(/clean stop is under way/)
})

test('the end of the stop says to resume once the credit is back', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await stopCleanly($, w, agents)

  expect(w.toasts.at(-1)).toMatch(
    new RegExp(`clean stop complete\\. Credit back ${BACK.source}: /graceful-stop resume then picks the work up\\.$`),
  )
})

test('a stop with nothing running says to resume too', async ($, on) => {
  const w = world(on, [])
  await $.session.measure(measure(90, 10))

  expect(w.toasts.at(-1)).toMatch(/nothing running\. No more requests will leave\. Credit back .*\/graceful-stop resume/)
})

// The band above the prompt.

const SURFACES = ['terminal', 'desktop'] as const

const band = ($: Engine, surface: (typeof SURFACES)[number], isWorking = false) =>
  $.ui.mount({
    plugin: 'graceful-stop',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {} },
  })

test('the band shows the state and a gauge per window, moving as the credit does', async ($, on) => {
  world(on, [AGENT])
  await $.session.measure(both(52, 31))
  for (const surface of SURFACES) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: ' ● ARMED ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' clean stop at 90 % (5h) · 95 % (7d) · overage budget $2.00 · 5 grace calls' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^ +52 %$/ }))?.props.color).toBe('#22c55e')
    expect(await ui.find({ type: 'Text', text: /^ {3}↻ (today|tomorrow) \d\d:\d\d · in 2 h 13$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ +31 %$/ })).toBeDefined()
    // The terminal paints the gauge cell by cell; the desktop draws it as text.
    // The gauges start under the badge and end under the `·` after `95 % (7d)`:
    // ` ● ARMED `, a space, `clean stop at 90 % (5h) · 95 % (7d)`, ` ·`.
    const span = ' ● ARMED '.length + 1 + 'clean stop at 90 % (5h) · 95 % (7d)'.length + 2
    expect(await ui.find({ type: 'Text', text: 'Session 5h' })).toBeDefined()
    // Each window's name is right-aligned on the mod's name above it.
    const names = (await ui.findAll({ type: 'Box' })).filter(b => b.props.justifyContent === 'flex-end')
    expect(names.map(b => b.props.width)).toEqual(['graceful-stop'.length, 'graceful-stop'.length])
    expect(await ui.find({ type: 'Text', text: 'Week 7d' })).toBeDefined()
    if (surface === 'terminal') {
      const bars = await ui.findAll({ type: 'Raster' })
      expect(bars.map(b => b.props.columns)).toEqual([span, span])
    }
    else {
      const runs = await ui.findAll({ type: 'Text', text: /▇/ })
      expect(runs.filter(r => r.props.color === '#a1a1aa').length).toBe(2)
    }
    await ui.unmount()
  }

  const ui = await band($, 'terminal')
  await $.session.measure(both(75, 31))
  expect((await ui.find({ type: 'Text', text: /^ +75 %$/ }))?.props.color).toBe('#f59e0b')
  await ui.unmount()
})

test('the band Off button turns the mod off, then On re-arms it', async ($, on) => {
  world(on, [AGENT])
  const ui = await band($, 'terminal')
  expect((await ui.find({ key: 'toggle' }))?.text).toBe('Off')

  await ui.press({ key: 'toggle' })
  expect(await command($, 'status')).toMatch(/^Phase: off/)
  expect((await ui.find({ key: 'toggle' }))?.text).toBe('On')
  expect(await ui.find({ type: 'Text', text: ' ● OFF ' })).toBeDefined()

  await ui.press({ key: 'toggle' })
  expect(await command($, 'status')).toMatch(/^Phase: armed/)
})

test('the band Resume button is dimmed until the credit is back, then resumes', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await stopCleanly($, w, agents)
  const ui = await band($, 'terminal')
  expect((await ui.find({ key: 'resume' }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: new RegExp(`^ stopped cleanly · credit back ${BACK.source}$`) })).toBeDefined()

  await ui.press({ key: 'resume' })
  expect(w.toasts.at(-1)).toMatch(/not been reset yet/)
  expect(w.prompts).toEqual([])
  await ui.unmount()

  await w.clock.set(Date.parse(RESETS_AT) + 60_000)
  const later = await band($, 'terminal')
  expect((await later.find({ key: 'resume' }))?.props.variant).toBe('primary')
  await later.press({ key: 'resume' })
  await w.clock.advance(1)
  expect(w.toasts.at(-1)).toMatch(/Resuming from/)
  expect(w.prompts[0]).toMatch(/The credit is back/)
})

test('the band Resume button waits while Claude is working', async ($, on) => {
  const w = world(on, [], { limits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: RESETS_AT }] })
  const ui = await band($, 'terminal', true)
  expect((await ui.find({ key: 'resume' }))?.props.dimColor).toBe(true)

  await ui.press({ key: 'resume' })
  expect(w.toasts.at(-1)).toMatch(/Claude is working/)
})

test('before its first answer the band says there is no reading yet', async ($, on) => {
  world(on, [], { limits: [] })
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /No credit reading yet/ })).toBeDefined()
  await ui.unmount()
})

test('before any change of the credit the band draws the reading Claude Code already has', async ($, on) => {
  world(on, [], { limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: RESETS_AT }] })
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ +12 %$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No credit reading yet/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Last reading/ })).toBeUndefined()
})

test('a fresh session draws the reading kept by the last one, said to be old', async ($, on) => {
  world(on, [], {
    limits: [],
    store: {
      credit: [{ kind: 'five_hour', percentUsed: 64, resetsAt: RESETS_AT }],
      creditAt: NOW - 30 * 60_000,
    },
  })
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ +64 %$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Last reading at (today|yesterday|\w+ \d+ \w+) \d\d:\d\d: it refreshes/ })).toBeDefined()
})

const start = {
  cwd: '/proj',
  surface: 'terminal' as const,
  isInteractive: true,
}

function host(on: On) {
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
}

test('a new session starts armed by default', async ($, on) => {
  world(on, [])
  host(on)
  await $.session.start(start)

  expect(await command($, 'status')).toMatch(/^Phase: armed/)
})

test('not armed at start, a session starts off and a reload keeps what the person chose', { options: { armAtStart: false } }, async ($, on) => {
  world(on, [])
  host(on)
  await $.session.start(start)
  expect(await command($, 'status')).toMatch(/^Phase: off/)

  await command($, 'on')
  await $.session.start(start)
  expect(await command($, 'status')).toMatch(/^Phase: armed/)
})

const output = ($: Engine, surface: (typeof SURFACES)[number], args: string, text: string) =>
  $.ui.mount({
    plugin: 'graceful-stop',
    surface,
    component: 'CommandOutput',
    props: { command: 'graceful-stop', args, text: `graceful-stop: ${text}`, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })

test('the status command draws the card, with the overage budget and the grace calls', async ($, on) => {
  world(on, [AGENT])
  await $.session.measure(both(52, 31))
  for (const surface of SURFACES) {
    const ui = await output($, surface, '', await command($, 'status'))
    expect(await ui.find({ type: 'Text', text: ' ● ARMED ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ +52 %$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· overage budget \$2\.00 · 5 grace calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Phase:/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^› / })).toBeUndefined()
    await ui.unmount()
  }
})

test('another command draws the card with what it did on top', async ($, on) => {
  world(on, [AGENT])
  await command($, 'off')
  const ui = await output($, 'terminal', 'on', await command($, 'on'))
  expect(await ui.find({ type: 'Text', text: /^› Re-armed: the clean stop will start at session 90%, weekly 95%\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ● ARMED ' })).toBeDefined()
})

test('/gs is the same command, its output the same card', async ($, on) => {
  world(on, [AGENT])
  await $.session.measure(both(52, 31))
  expect(await command($, 'off', 'gs')).toMatch(/^Off for this session/)
  expect(await command($, '', 'gs')).toMatch(/^Phase: off/)

  const ui = await $.ui.mount({
    plugin: 'graceful-stop',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'gs', args: 'on', text: `gs: ${await command($, 'on', 'gs')}`, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })
  expect(await ui.find({ type: 'Text', text: /^› Re-armed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ● ARMED ' })).toBeDefined()
})

// The code review of 0.4.2, one test per finding.

const LOW = { limits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: RESETS_AT }] }

test('a memo kept from another project is never resumed', async ($, on) => {
  const other = '/elsewhere/GRACEFUL-STOP_2026-10-06_15h40.md'
  const w = world(on, [], { ...LOW, store: { memoPath: other } })
  w.files.set(other, '# Their memo')
  expect(await command($, 'resume')).toMatch(/^No resume memo found/)

  w.files.set('/proj/GRACEFUL-STOP_2026-10-05_21h30.md', '# Ours')
  expect(await command($, 'resume')).toMatch(/proj[\/]GRACEFUL-STOP_2026-10-05_21h30\.md\.$/)
})

test('a memo already resumed from is not resumed again', async ($, on) => {
  const w = world(on, [], LOW)
  w.files.set('/proj/GRACEFUL-STOP_2026-10-05_21h30.md', '# Memo')
  expect(await command($, 'resume')).toMatch(/Resuming from/)
  await w.clock.advance(1)
  expect(w.prompts.length).toBe(1)

  expect(await command($, 'resume')).toMatch(/^No resume memo found/)
  await w.clock.advance(1)
  expect(w.prompts.length).toBe(1)
})

test('a real memo that keeps the provisional first line is not overwritten', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await $.session.measure(measure(90, 10))
  const [path = ''] = [...w.files.keys()]
  const real = `${(w.files.get(path) ?? '').split('\n')[0]}\n# Real memo, edited in place`
  w.files.set(path, real)

  agents[0] = { ...AGENT, status: 'completed' }
  await $.turn.complete(agentDone('agent-1'))
  agents.splice(0, agents.length)
  await $.turn.complete(mainDone('main-1'))
  expect(await step($)).toMatch(/Session stopped cleanly/)
  expect(w.files.get(path)).toBe(real)
})

test('parallel tool calls keep to the grace calls and warn once', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(90, 10))
  const calls = await Promise.all(Array.from({ length: 8 }, () => $.tool.call(bash('agent-2'))))

  expect(calls.filter(c => c.deny !== undefined).length).toBe(3)
  expect(w.notes.filter(n => n.agentId === 'agent-2').length).toBe(1)
})

test('a reading taken before its window reset starts no new stop after a resume', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await stopCleanly($, w, agents)
  await w.clock.set(Date.parse(RESETS_AT) + 60_000)
  expect(await command($, 'resume')).toMatch(/Resuming from/)
  const notes = w.notes.length

  agents.push(AGENT)
  await $.session.measure(measure(100, 10))
  expect(w.notes.length).toBe(notes)
  expect(await command($, 'status')).toMatch(/^Phase: armed/)
})

test(
  'a setting out of its bounds gives way to its default, and the start says so',
  { options: { sessionThreshold: 0, weeklyThreshold: 250, overageBudgetUsd: -1 } },
  async ($, on) => {
    const w = world(on, [AGENT])
    host(on)
    await $.session.start(start)
    expect(w.toasts.at(-1)).toBe(
      'graceful-stop: not a valid value in /config, the default applies: Session trigger threshold, Weekly trigger threshold, Overage budget.',
    )
    expect(await command($, 'status')).toMatch(/thresholds session 90%, weekly 95%, overage budget \$2\.00/)

    await $.session.measure(measure(89, 10))
    expect(w.notes).toEqual([])
    await $.session.measure(measure(90, 10))
    expect(w.notes.length).toBeGreaterThan(0)
  },
)

test('an interrupted subagent is not reported as completed', async ($, on) => {
  const agents = [AGENT]
  const w = world(on, agents)
  await $.session.measure(measure(90, 10))
  agents[0] = { ...AGENT, status: 'completed' }
  await $.turn.complete({ ...agentDone('agent-1'), isAborted: true, reason: 'aborted' as const })

  const memo = [...w.files.values()][0] ?? ''
  expect(memo).toMatch(/Status: interrupted/)
  expect(/Status: completed/.test(memo)).toBe(false)
})

test('the card and resume read the same credit, the higher figure of a window', async ($, on) => {
  const w = world(on, [], LOW)
  w.files.set('/proj/GRACEFUL-STOP_2026-10-05_21h30.md', '# Memo')
  await command($, 'off')
  // A measure read more than the engine reads now: use only grows in a window.
  await $.session.measure(measure(92, 10))

  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ +92 %$/ })).toBeDefined()
  expect((await ui.find({ key: 'resume' }))?.props.dimColor).toBe(true)
  expect(await command($, 'resume')).toMatch(/not been reset yet/)
})

test('memo names are in local time, and a second stop in the same minute gets its own', async ($, on) => {
  const w = world(on, [AGENT])
  await $.session.measure(measure(90, 10))
  await command($, 'on')
  await $.session.measure(measure(91, 10))

  const d = new Date(NOW)
  const p = (n: number) => String(n).padStart(2, '0')
  const base = `GRACEFUL-STOP_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`
  expect([...w.files.keys()].map(k => k.replace(/^.*\//, ''))).toEqual([`${base}.md`, `${base}-2.md`])
})

test('an unknown subcommand is refused and lists the valid ones', async ($, on) => {
  const w = world(on, [AGENT])
  expect(await command($, 'stpo')).toBe('Unknown subcommand "stpo". Use one of: status, stop, resume, on, off.')
  expect(w.notes).toEqual([])
  expect(await command($, 'status')).toMatch(/^Phase: armed/)
})

test('the gauges leave a thin line of the terminal background between them', async ($, on) => {
  world(on, [AGENT])
  await $.session.measure(both(52, 31))
  const ui = await band($, 'terminal')
  const [bar] = await ui.findAll({ type: 'Raster' })
  const bytes = Uint8Array.from(atob(String(bar?.props.cells)), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const cells = Array.from({ length: words.length / 3 }, (_, i) => ({
    glyph: String.fromCodePoint(words[i * 3] ?? 0),
    fg: words[i * 3 + 1],
    bg: words[i * 3 + 2],
  }))

  // Every cell, the threshold's mark too, is the lower seven eighths of a
  // block over the terminal's own background.
  expect(cells.every(c => c.glyph === '▇' && c.bg === 0x01000000)).toBe(true)
  expect(cells.filter(c => c.fg === 0xa1a1aa).length).toBe(1)
  await ui.unmount()
})

// The account's credit, as Claude Code's /usage reads it.

const SESSION_59 = { limits: [{ kind: 'five_hour', percentUsed: 59, resetsAt: RESETS_AT }] }

function usageEndpoint(on: On, answer: unknown, login: 'bearer' | 'api-key' | null = 'bearer') {
  const calls: { url: string; auth?: string }[] = []
  on('session.authorize', () => ({ value: login === null ? null : { handle: 'handle-1', kind: login } }))
  on('http.fetch', (_$, e) => {
    calls.push({ url: e.url, auth: e.init?.auth })

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })

  return calls
}

const ACCOUNT_98 = {
  five_hour: { utilization: 98, resets_at: RESETS_AT },
  seven_day: { utilization: 32, resets_at: '2026-10-10T17:00:00Z' },
}

test('the card shows the account credit, whatever session or app spent it', async ($, on) => {
  const w = world(on, [], SESSION_59)
  host(on)
  const calls = usageEndpoint(on, ACCOUNT_98)
  await command($, 'off')
  await $.session.start(start)
  await w.clock.advance(1)

  expect(calls).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'handle-1' }])
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ +98 %$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ +59 %$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ +32 %$/ })).toBeDefined()
  expect(await command($, 'status')).toMatch(/Credit: five_hour 98%, seven_day 32%/)
})

test('the account credit is read again each minute', async ($, on) => {
  const w = world(on, [], SESSION_59)
  host(on)
  const calls = usageEndpoint(on, ACCOUNT_98)
  await command($, 'off')
  await $.session.start(start)
  await w.clock.advance(1)
  await w.clock.advance(60_000)

  expect(calls.length).toBe(2)
})

test('the account credit starts the clean stop, though this session spent little', async ($, on) => {
  const w = world(on, [AGENT], SESSION_59)
  host(on)
  usageEndpoint(on, { five_hour: { utilization: 91, resets_at: RESETS_AT } })
  await $.session.start(start)
  await w.clock.advance(1)

  expect(w.notes.find(n => n.agentId === 'agent-1')?.text).toMatch(/five_hour at 91%/)
  expect(await command($, 'status')).toMatch(/^Phase: stopping/)
})

test('without a subscription login the card keeps the session reading and asks nothing', async ($, on) => {
  const w = world(on, [], SESSION_59)
  host(on)
  const calls = usageEndpoint(on, ACCOUNT_98, 'api-key')
  await $.session.start(start)
  await w.clock.advance(1)

  expect(calls).toEqual([])
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ +59 %$/ })).toBeDefined()
})

test('an answer that reads as nothing keeps the session reading', async ($, on) => {
  const w = world(on, [], SESSION_59)
  host(on)
  usageEndpoint(on, { error: 'not found' })
  await $.session.start(start)
  await w.clock.advance(1)

  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ +59 %$/ })).toBeDefined()
  expect(await command($, 'status')).toMatch(/^Phase: armed/)
})
