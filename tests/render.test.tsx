import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PLUGIN = 'graceful-stop'

const NOTE =
  '[graceful-stop] The Claude session credit has reached five_hour at 90%. Clean stop started.'
const BRAKE = '[graceful-stop] Session stopped cleanly (five_hour at 90%). No request was sent to the model.'

// What the engine draws beneath the plugin when the mod passes a row on.
function engine(on: On) {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text key="engine">engine row</Text>
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text key="engine">engine row</Text>
  })
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text key="engine">engine row</Text>
  })
}

const userRow = (text: string) => ({
  component: 'UserMessage' as const,
  props: { text, origin: { kind: 'plugin', name: PLUGIN }, isExpanded: false } as never,
})

test('the mod notes to the orchestrator are drawn under its yellow label', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...userRow(NOTE) })
    expect(await ui.find({ type: 'Text', text: '⏹  graceful-stop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^The Claude session credit has reached/ })).toBeDefined()
    expect(await ui.find({ key: 'engine' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the brake answers are drawn as the mod, not as a reply of the model', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AssistantMessage',
      props: { text: BRAKE, isFirstOfReply: true } as never,
    })
    expect(await ui.find({ type: 'Text', text: '⏹  graceful-stop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Session stopped cleanly/ })).toBeDefined()
    await ui.unmount()
  }
})

test('every other row is left to the engine', async ($, on) => {
  engine(on)
  for (const surface of SURFACES) {
    const typed = await $.ui.mount({ plugin: PLUGIN, surface, ...userRow('Analyse my repositories please') })
    expect(await typed.find({ type: 'Text', text: '⏹  graceful-stop' })).toBeUndefined()
    await typed.unmount()

    const reply = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AssistantMessage',
      props: { text: 'Here is the analysis.', isFirstOfReply: true } as never,
    })
    expect(await reply.find({ type: 'Text', text: '⏹  graceful-stop' })).toBeUndefined()
    await reply.unmount()
  }
})
