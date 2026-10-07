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
    limits: where.limits ?? [{ kind: 'five_hour', percentUsed: 90, resetsAt: RESETS_AT }],
    clock: mock.clock(on, { now: NOW }),
  }
  mock.store(on, where.store)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
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
  expect(path).toMatch(/CLEAN-END-OF-SESSION_.*\.md$/)
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

const command = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'clean-end-of-session',
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
  expect(path).toMatch(/proj[\\/]CLEAN-END-OF-SESSION_/)
})

test('outside a repository the memo goes to the session root', async ($, on) => {
  const w = world(on, [AGENT], { root: '/work/notes', repo: null })
  await $.session.measure(measure(90, 10))

  const [path] = [...w.files.keys()]
  expect(path).toMatch(/notes[\\/]CLEAN-END-OF-SESSION_/)
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
  key: `clean-end-of-session.${field}`,
  label,
  isHidden: false,
  provider: { plugin: 'clean-end-of-session', tier: 'user' as const },
})

function menu(on: On) {
  on('config.describe', (_$, e) => ({ label: e.label, description: e.description, isHidden: e.isHidden }))
  on('ui.invalidate', () => ({ value: undefined }))
}

test('the settings fold under a closed chevron by default', async ($, on) => {
  menu(on)
  const toggle = await $.config.describe(describeRow('showSettings', 'clean-end-of-session'))
  const threshold = await $.config.describe(describeRow('sessionThreshold', 'clean-end-of-session · Session trigger threshold (%)'))
  const other = await $.config.describe({ ...describeRow('x', 'Theme'), key: 'theme' })

  expect(toggle.label).toBe('▸ clean-end-of-session')
  expect(threshold.isHidden).toBe(true)
  expect(other.isHidden).toBe(false)
})

test('an open chevron shows every setting, each led by the mod name', { options: { showSettings: true } }, async ($, on) => {
  menu(on)
  const toggle = await $.config.describe(describeRow('showSettings', 'clean-end-of-session'))
  const threshold = await $.config.describe(describeRow('sessionThreshold', 'clean-end-of-session · Session trigger threshold (%)'))

  expect(toggle.label).toBe('▾ clean-end-of-session')
  expect(threshold.isHidden).toBe(false)
  expect(threshold.label).toMatch(/^clean-end-of-session · /)
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

  expect(await step($)).toMatch(new RegExp(`Credit back ${BACK.source}: /clean-end-of-session resume`))
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

  expect(said).toMatch(/^Re-armed .* Resuming from .*CLEAN-END-OF-SESSION_.*\.md\.$/)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toMatch(/^\[clean-end-of-session\] The credit is back/)
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
  const kept = '/proj/CLEAN-END-OF-SESSION_2026-10-06_15h40.md'
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
  w.files.set('/proj/CLEAN-END-OF-SESSION_2026-10-01_09h00.md', '# Older')
  w.files.set('/proj/CLEAN-END-OF-SESSION_2026-10-05_21h30.md', '# Newer')
  w.files.set('/proj/README.md', '# Readme')

  expect(await command($, 'resume')).toMatch(/2026-10-05_21h30\.md\.$/)
})

test('with no memo at all, resume says so and changes nothing', async ($, on) => {
  const w = world(on, [], { limits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: RESETS_AT }] })
  await command($, 'off')

  expect(await command($, 'resume')).toMatch(/^No resume memo found in .*proj\. \/clean-end-of-session on re-arms/)
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
