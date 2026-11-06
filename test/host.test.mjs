import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'

import {
  RUNNING_TTL_MS,
  TAIL_PATH,
  apply,
  createCache,
  createRecorder,
  createTailHandler,
  describeTail,
  eventStamp,
  isRunning,
  loadTail,
} from '../lib/index.js'

/** Minimal node:http response stand-in. */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      this.body = chunk ?? ''
      return this
    },
    json() {
      return JSON.parse(this.body)
    },
  }
  return res
}

function fakeCtx(services = {}) {
  return {
    connection: { requestRejection: services.reject },
    webServer: { register: services.register },
    get(name) {
      return services[name]
    },
  }
}

test('rejects untrusted requests before doing any work', async () => {
  let called = false
  const handler = createTailHandler(fakeCtx(), {
    reject: () => 401,
    describe: async () => {
      called = true
      return { ok: true, items: [] }
    },
  })
  const res = fakeRes()
  await handler({ method: 'GET', url: `${TAIL_PATH}?session=abc`, headers: {} }, res)
  assert.equal(res.status, 401)
  assert.equal(called, false)
})

test('rejects a cross-origin request with 403 from the trust fence', async () => {
  const ctx = {
    connection: { requestRejection: () => 403 },
    get: () => undefined,
  }
  const res = fakeRes()
  await createTailHandler(ctx)({ method: 'GET', url: `${TAIL_PATH}?session=abc` }, res)
  assert.equal(res.status, 403)
})

test('validates method and session id', async () => {
  const handler = createTailHandler(fakeCtx(), { reject: () => undefined, describe: async () => ({ ok: true, items: [] }) })

  const post = fakeRes()
  await handler({ method: 'POST', url: `${TAIL_PATH}?session=abc` }, post)
  assert.equal(post.status, 405)

  for (const bad of ['', '..', 'a/b', '../etc/passwd', 'x'.repeat(200), 'has space']) {
    const res = fakeRes()
    await handler({ method: 'GET', url: `${TAIL_PATH}?session=${encodeURIComponent(bad)}` }, res)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`)
    assert.equal(res.json().ok, false)
  }
})

test('serves lines for a known session and clamps the limit', async () => {
  const seen = []
  const handler = createTailHandler(fakeCtx(), {
    reject: () => undefined,
    describe: async (_ctx, sessionId, limit) => {
      seen.push([sessionId, limit])
      return { ok: true, session: sessionId, source: 'live', eventCount: 12, items: [{ kind: 'command', text: 'ls' }] }
    },
    record: () => {},
  })

  const res = fakeRes()
  await handler({ method: 'GET', url: `${TAIL_PATH}?session=session-1&limit=99` }, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json().items, [{ kind: 'command', text: 'ls' }])
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(seen, [['session-1', 8]])

  const fallback = fakeRes()
  await handler({ method: 'GET', url: `${TAIL_PATH}?session=session-1` }, fallback)
  assert.deepEqual(seen[1], ['session-1', 4])
})

test('unknown session answers 404 and read failures answer 500', async () => {
  const missing = createTailHandler(fakeCtx(), {
    reject: () => undefined,
    describe: async () => ({ ok: false, error: 'unknown session', items: [] }),
  })
  const notFound = fakeRes()
  await missing({ method: 'GET', url: `${TAIL_PATH}?session=ghost` }, notFound)
  assert.equal(notFound.status, 404)

  const broken = createTailHandler(fakeCtx(), {
    reject: () => undefined,
    describe: async () => { throw new Error('boom') },
  })
  const failed = fakeRes()
  await broken({ method: 'GET', url: `${TAIL_PATH}?session=session-1` }, failed)
  assert.equal(failed.status, 500)
  assert.equal(failed.json().message, 'boom')
})

test('loadTail prefers the live gateway and falls back to disk', async () => {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
  ]
  const live = await loadTail(fakeCtx({
    sessions: { get: () => ({ seq: 1, snapshotEvents: () => events }) },
  }), 'session-1')
  assert.equal(live.source, 'live')
  assert.equal(live.eventCount, 1)

  const opened = []
  const stored = await loadTail(fakeCtx({
    sessions: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({ eventCount: 1 }),
      open: async (id, mode) => {
        opened.push([id, mode])
        return {
          read: async () => ({ events }),
          close: async () => {},
        }
      },
    },
  }), 'session-2')
  assert.equal(stored.source, 'stored')
  assert.deepEqual(opened, [['session-2', 'read']])

  const unknown = await loadTail(fakeCtx({ sessions: { get: () => undefined } }), 'session-3')
  assert.equal(unknown, undefined)
})

test('describeTail turns a stored session into card lines', async () => {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '看一下日志' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [
      { type: 'reasoning', text: '先数事件条数' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"wc -l log"}' },
    ] } } },
  ]
  const ctx = fakeCtx({
    sessions: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({ eventCount: 2 }),
      open: async () => ({ read: async () => ({ events }), close: async () => {} }),
    },
  })
  const payload = await describeTail(ctx, 'session-9', 4)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.items.map((item) => item.kind), ['user', 'thinking', 'command'])
  assert.equal(payload.eventCount, 2)
})

test('isRunning tracks an open, recent turn', () => {
  const now = 1_000_000
  const open = [
    { type: 'turn/start', time: now - 2_000 },
    { type: 'assistant/message', time: now - 1_500 },
  ]
  assert.equal(isRunning(open, now), true)
  assert.equal(isRunning([...open, { type: 'turn/end', time: now - 1_000 }], now), false)
  // An interrupted run must not look live forever.
  assert.equal(isRunning(open, now + RUNNING_TTL_MS + 1), false)
  assert.equal(isRunning([], now), false)
})

test('describeTail reports whether the turn is still running', async () => {
  const now = 5_000_000
  const events = [
    { type: 'turn/start', seq: 1, time: now - 3_000 },
    { type: 'user/message', seq: 2, time: now - 2_500, data: { message: { content: [{ type: 'text', text: '跑一下' }] } } },
    { type: 'assistant/message', seq: 3, time: now - 2_000, data: { message: { content: [{ type: 'reasoning', text: '正在跑' }] } } },
  ]
  const ctx = fakeCtx({
    sessions: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({ eventCount: 3 }),
      open: async () => ({ read: async () => ({ events }), close: async () => {} }),
    },
  })
  const live = await describeTail(ctx, 'session-run', 4, { now })
  assert.equal(live.running, true)
  assert.equal(live.updatedAt, now - 2_000)
  const finished = await describeTail(ctx, 'session-run', 4, { now: now + RUNNING_TTL_MS + 10_000 })
  assert.equal(finished.running, false)
})

test('eventStamp changes only when new events land', async () => {
  let seq = 7
  const ctx = fakeCtx({ sessions: { get: () => ({ seq, snapshotEvents: () => [] }) } })
  assert.equal(await eventStamp(ctx, 'session-1'), 'live:7')
  seq = 9
  assert.equal(await eventStamp(ctx, 'session-1'), 'live:9')

  const stored = fakeCtx({
    sessions: { get: () => undefined },
    sessionPersistence: { stat: async () => ({ eventCount: 12 }) },
  })
  assert.equal(await eventStamp(stored, 'session-2'), 'stored:12')
  assert.equal(await eventStamp(fakeCtx({ sessions: { get: () => undefined } }), 'session-3'), undefined)
})

test('cache serves repeated polls from memory', async () => {
  const cache = createCache(50)
  let produced = 0
  const produce = async () => { produced += 1; return produced }
  assert.equal(await cache.get('a', produce), 1)
  assert.equal(await cache.get('a', produce), 1)
  assert.equal(produced, 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(await cache.get('a', produce), 2)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('recorder writes a content-free activation note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-recorder-'))
  const file = join(dir, 'session-progress', 'status.json')
  const recorder = createRecorder(file)
  recorder.mark()
  recorder.record('session-abcdef', false)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const note = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(note.requests, 1)
  assert.equal(note.failures, 0)
  assert.equal(note.lastSession, 'session-abcdef')
  assert.equal(typeof note.pid, 'number')
  assert.ok(!('items' in note) && !('text' in note))
})

test('apply registers the exact route inside an effect', () => {
  const registered = []
  const effects = []
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    get: () => undefined,
    effect(fn, label) {
      effects.push(label)
      fn()
    },
  }
  const handle = apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'exact')
  assert.equal(registered[0].path, TAIL_PATH)
  assert.equal(typeof registered[0].handler, 'function')
  assert.deepEqual(effects, ['session-progress: hover tail route'])
  assert.equal(handle.recorder.state.requests, 0)
})

test('real session ledger produces sane lines', async (t) => {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return t.skip('no local session ledger')
  const files = []
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace)
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      const file = join(dir, entry, 'session.v4.jsonl.zstd')
      if (existsSync(file)) files.push([file, statSync(file).size])
    }
  }
  if (files.length === 0) return t.skip('no compressed session logs')
  files.sort((a, b) => b[1] - a[1])

  const raw = zstdDecompressSync(readFileSync(files[0][0])).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* torn tail */ }
  }
  assert.ok(events.length > 0)

  const payload = await describeTail(fakeCtx({
    sessions: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({ eventCount: events.length }),
      open: async () => ({
        read: async (offset, length) => ({ events: events.slice(offset, offset + length) }),
        close: async () => {},
      }),
    },
  }), 'session-real', 4)

  assert.equal(payload.ok, true)
  assert.ok(payload.items.length > 0, 'expected at least one line from a real session')
  for (const item of payload.items) {
    assert.ok(['user', 'thinking', 'command', 'output', 'answer'].includes(item.kind))
    assert.ok(item.text.length > 0 && item.text.length <= 650)
  }
})
