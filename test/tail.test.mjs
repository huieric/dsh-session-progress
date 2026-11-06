import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LINE_KINDS,
  clip,
  describeSessionProgress,
  describeToolCall,
  normalizeLimit,
} from '../lib/tail.js'

test('clip collapses whitespace and cuts on code points', () => {
  assert.equal(clip('  a \n\n b  '), 'a b')
  assert.equal(clip(''), '')
  assert.equal(clip('abcdef', 4), 'abc…')
  // Astral characters must not be split into half a surrogate pair.
  const emoji = '🙂'.repeat(5)
  const cut = clip(emoji, 3)
  assert.equal(Array.from(cut).length, 3)
  assert.ok(cut.endsWith('…'))
})

test('LINE_KINDS covers every kind the Host emits', () => {
  assert.deepEqual([...LINE_KINDS], ['user', 'thinking', 'command', 'output', 'answer'])
})

test('describeToolCall prefers the shell command, then the path', () => {
  assert.equal(describeToolCall('bash', '{"command":"ls -la\\nsecond line"}'), 'ls -la')
  assert.equal(describeToolCall('read', { file_path: '/tmp/report.md' }), '/tmp/report.md')
  assert.equal(describeToolCall('grep', '{"pattern":"TODO"}'), 'TODO')
  assert.equal(describeToolCall('mystery', '{"other":"value"}'), 'value')
  assert.equal(describeToolCall('mystery', 'not json at all'), 'not json at all')
  assert.equal(describeToolCall('noargs', ''), 'noargs()')
})

test('describeSessionProgress maps event types onto line kinds', () => {
  const events = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '修一下 hover 卡片' }] } } },
    { type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '先看会话日志结构' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls .dsh/sessions"}' },
    ] } } },
    // The same call reported again through tool/call must not duplicate the line.
    { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls .dsh/sessions"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'session-a\nsession-b' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已确认，开始写插件。' }] } } },
  ]

  const lines = describeSessionProgress(events, { limit: 8 })
  assert.deepEqual(lines.map((line) => line.kind), ['user', 'thinking', 'command', 'output', 'answer'])
  assert.equal(lines[2].text, 'ls .dsh/sessions')
  assert.equal(lines[2].tool, 'bash')
  assert.equal(lines[3].text, 'session-a session-b')
})

test('describeSessionProgress keeps the newest lines and clamps the limit', () => {
  const events = []
  for (let index = 0; index < 20; index += 1) {
    events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text: `step ${index}` }] } } })
  }
  const lines = describeSessionProgress(events, { limit: 2 })
  assert.equal(lines.length, 2)
  assert.equal(lines[1].text, 'step 19')
  assert.equal(describeSessionProgress([], { limit: 4 }).length, 0)
  assert.equal(normalizeLimit('99'), 8)
  assert.equal(normalizeLimit('0'), 1)
  assert.equal(normalizeLimit('abc'), 4)
})

test('describeSessionProgress ignores malformed events', () => {
  const lines = describeSessionProgress([
    null,
    {},
    { type: 'assistant/message' },
    { type: 'assistant/message', data: { message: { content: [null, { type: 'reasoning' }] } } },
    { type: 'tool/result', data: {} },
  ])
  assert.deepEqual(lines, [])
})
