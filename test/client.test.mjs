import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

const requireFromRepo = createRequire(join(here, '..', 'package.json'))
const React = requireFromRepo('react')
const { renderToStaticMarkup } = requireFromRepo('react-dom/server')

/** Load the shipped bundle exactly as the browser module loader would. */
function loadClient(options = {}) {
  let entry
  const appended = []
  const sandbox = {
    console,
    setTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URL,
    // Resolve at call time so a test can swap the global later.
    fetch: (...args) => globalThis.fetch(...args),
    document: options.document,
    window: {
      __ModuleLoader__: {
        load(candidate) {
          entry = candidate
        },
      },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'dsh-session-progress/lib/client.js' })
  assert.ok(entry, 'bundle must call window.__ModuleLoader__.load')
  assert.equal(entry.id, 'dsh-session-progress')
  const client = entry.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  return { client, appended }
}

/** Minimal document stand-in recording injected <style> tags. */
function fakeDocument() {
  const styles = []
  return {
    styles,
    head: {
      querySelector(selector) {
        return styles.find((style) => `style[data-plugin-css="${style.tag}"]` === selector) ?? null
      },
      appendChild(node) {
        styles.push({ tag: node.attributes['data-plugin-css'], plugin: node.attributes['data-plugin'], css: node.textContent })
        return node
      },
    },
    createElement(tag) {
      assert.equal(tag, 'style')
      return {
        attributes: {},
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value },
      }
    },
  }
}

test('bundle declares the slot plugin contract', () => {
  const { client } = loadClient()
  assert.deepEqual([...client.inject], ['slots', 'locale'])
  assert.equal(client.ENDPOINT, '/dsh-session-progress/tail')
  assert.equal(typeof client.apply, 'function')
  assert.equal(typeof client.SessionProgressHover, 'function')
  assert.deepEqual(Object.keys(client.DICT.zh).sort(), ['answer', 'command', 'output', 'thinking', 'unavailable', 'user'])
  assert.deepEqual(Object.keys(client.DICT.en).sort(), Object.keys(client.DICT.zh).sort())
})

test('apply registers locale dictionaries and the hover slot', () => {
  const document = fakeDocument()
  const { client } = loadClient({ document })
  const locales = []
  const injects = []
  const registrations = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      fn()
    },
    locale: {
      register(namespace, dict) {
        locales.push([namespace, dict])
        return () => {}
      },
    },
    slots: {
      inject(slotName, factory) {
        injects.push(slotName)
        factory()
      },
      register(options, component) {
        registrations.push([options, component])
        return () => {}
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(effects, ['session-progress: locale'])
  assert.equal(locales.length, 1)
  assert.equal(locales[0][0], 'session-progress')
  assert.equal(locales[0][1].zh.thinking, '思考')

  assert.deepEqual(injects, ['sidebar.session.row.hover'])
  const [options, component] = registrations[0]
  assert.equal(options.name, 'sidebar.session.row.hover')
  assert.equal(options.id, 'session-progress')
  assert.equal(options.locale, 'session-progress')
  assert.equal(component, client.SessionProgressHover)

  assert.equal(document.styles.length, 1)
  assert.equal(document.styles[0].plugin, 'dsh-session-progress')
  // Long lines wrap inside a widened card instead of ending in an ellipsis.
  assert.match(document.styles[0].css, /\.dsp-hover__text\{[^}]*white-space:pre-wrap/)
  assert.match(document.styles[0].css, /\.dsp-hover__text\{[^}]*overflow-wrap:anywhere/)
  assert.ok(!document.styles[0].css.includes('text-overflow:ellipsis'))
  assert.match(document.styles[0].css, /div:has\(> div > div > \.dsp-hover\)\{width:372px/)
})

test('CSS is injected only once', () => {
  const document = fakeDocument()
  const { client } = loadClient({ document })
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_name, factory) => factory(), register: () => () => {} },
  }
  client.apply(ctx)
  client.apply(ctx)
  assert.equal(document.styles.length, 1)
})

test('renderLines marks the newest line while the session is running', () => {
  const { client } = loadClient()
  const items = [
    { kind: 'command', text: 'npm test' },
    { kind: 'output', text: 'pass 28\nfail 0' },
  ]
  const live = renderToStaticMarkup(client.renderLines(items, (key) => client.DICT.zh[key], true))
  assert.match(live, /dsp-hover--live/)
  assert.match(live, /dsp-hover__caret/)
  // Only the newest row is flagged fresh; the older row must not re-animate.
  assert.equal((live.match(/dsp-hover__row--fresh/g) ?? []).length, 1)
  const idle = renderToStaticMarkup(client.renderLines(items, (key) => client.DICT.zh[key], false))
  assert.ok(!idle.includes('dsp-hover__caret'))
  assert.ok(!idle.includes('dsp-hover--live'))
})

test('renderLines draws labelled rows and hides itself when empty', () => {
  const { client } = loadClient()
  const items = [
    { kind: 'thinking', text: '先看会话日志结构' },
    { kind: 'command', text: 'ls .dsh/sessions' },
    { kind: 'output', text: 'session-a session-b' },
    { kind: 'answer', text: '已确认，开始写插件。' },
  ]
  const html = renderToStaticMarkup(client.renderLines(items, (key) => client.DICT.zh[key]))
  assert.match(html, /dsp-hover__row--thinking/)
  assert.match(html, /思考/)
  assert.match(html, /命令/)
  assert.match(html, /ls \.dsh\/sessions/)
  assert.match(html, /已确认，开始写插件。/)
  assert.equal((html.match(/dsp-hover__row /g) ?? []).length, 4)
  assert.equal(client.renderLines([], () => ''), null)
  assert.equal(client.renderLines(null, () => ''), null)
})

test('renderLines escapes markup in session text', () => {
  const { client } = loadClient()
  const html = renderToStaticMarkup(client.renderLines(
    [{ kind: 'answer', text: '<img src=x onerror=alert(1)>' }],
    (key) => key,
  ))
  assert.ok(!html.includes('<img'))
  assert.match(html, /&lt;img/)
})

test('normalizeItems drops malformed payloads', () => {
  const { client } = loadClient()
  const roundTrip = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTrip(client.normalizeItems(null)), [])
  assert.deepEqual(roundTrip(client.normalizeItems({ ok: false, items: [{ kind: 'answer', text: 'x' }] })), [])
  assert.deepEqual(
    roundTrip(client.normalizeItems({ ok: true, items: [{ kind: 'command', text: 'ls' }, null, { text: '' }, 'nope'] })),
    [{ kind: 'command', text: 'ls' }],
  )
})

test('createPoller fetches immediately, polls, and stops on demand', async () => {
  const calls = []
  let intervalCallback
  let cleared = null
  let delay = null
  const poller = loadClient().client.createPoller({
    sessionId: 'session-42',
    interval: 1000,
    liveInterval: 600,
    fetchImpl: async (url) => {
      calls.push(url)
      return {
        ok: true,
        json: async () => ({ ok: true, running: false, items: [{ kind: 'command', text: 'ls' }, { kind: 'answer', text: 'done' }] }),
      }
    },
    setIntervalImpl: (fn, ms) => {
      intervalCallback = fn
      delay = ms
      return 7
    },
    clearIntervalImpl: (id) => { cleared = id },
    onState: (items, live) => { calls.push(['state', items.map((item) => item.kind).join(','), live]) },
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls[0], '/dsh-session-progress/tail?session=session-42&limit=4')
  assert.deepEqual(calls[1], ['state', 'command,answer', false])
  assert.equal(delay, 1000, 'idle sessions keep the relaxed cadence')

  intervalCallback()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 4)
  assert.equal(poller.running, true)

  poller.stop()
  assert.equal(cleared, 7)
  assert.equal(poller.running, false)
  poller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 4, 'a stopped poller must not fetch again')
})

test('createPoller tightens its cadence while the turn is running', async () => {
  let delay = null
  let running = true
  const cleared = []
  const client = loadClient().client
  const poller = client.createPoller({
    sessionId: 'session-live',
    interval: 1800,
    liveInterval: 600,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, running, items: [{ kind: 'thinking', text: 'working' }] }) }),
    setIntervalImpl: (_fn, ms) => {
      delay = ms
      return 11
    },
    clearIntervalImpl: (id) => { cleared.push(id) },
    onState: () => {},
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(delay, 600, 'a running session polls fast')
  assert.equal(poller.live, true)

  running = false
  await poller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(delay, 1800, 'an idle session relaxes again')
  assert.equal(poller.live, false)
  assert.equal(cleared.length, 2)
  poller.stop()
})

test('createPoller gives up after consecutive failures', async () => {
  const failures = []
  let stopped = false
  const poller = loadClient().client.createPoller({
    sessionId: 'session-bad',
    maxFailures: 2,
    fetchImpl: async () => { throw new Error('offline') },
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => { stopped = true },
    onFailure: (error) => failures.push(error.message),
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await poller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(failures, ['offline', 'offline'])
  assert.equal(poller.running, false)
  assert.equal(stopped, true)
})

test('createPoller refuses ids the Host would reject', async () => {
  let fetched = false
  const poller = loadClient().client.createPoller({
    sessionId: '../etc/passwd',
    fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) } },
  })
  poller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(fetched, false)
  assert.equal(poller.running, false)
})

test('hover component renders live progress from the route', async () => {
  const { client } = loadClient()
  const TestRenderer = requireFromRepo('react-test-renderer')
  const { act } = TestRenderer
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const requested = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    requested.push(url)
    return {
      ok: true,
      json: async () => ({
        ok: true,
        running: true,
        items: [
          { kind: 'thinking', text: '先看日志' },
          { kind: 'command', text: 'wc -l session.v4.jsonl.zstd' },
          { kind: 'output', text: '2055' },
        ],
      }),
    }
  }

  let renderer
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(client.SessionProgressHover, { sessionId: 'session-77', t: (key) => client.DICT.zh[key] }),
      )
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

    assert.deepEqual(requested, ['/dsh-session-progress/tail?session=session-77&limit=4'])
    const json = JSON.stringify(renderer.toJSON())
    assert.match(json, /思考/)
    assert.match(json, /wc -l session\.v4\.jsonl\.zstd/)
    assert.match(json, /2055/)
    // A running session shows the live caret at the end of the newest line.
    assert.match(json, /dsp-hover__caret/)
    assert.match(json, /dsp-hover--live/)
  } finally {
    await act(async () => { renderer?.unmount() })
    globalThis.fetch = originalFetch
  }
})

test('hover component renders nothing for an invalid id', async () => {
  const { client } = loadClient()
  const TestRenderer = requireFromRepo('react-test-renderer')
  const { act } = TestRenderer
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(client.SessionProgressHover, { sessionId: '', t: (key) => key }))
  })
  assert.equal(renderer.toJSON(), null)
  await act(async () => { renderer.unmount() })
})
