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
  assert.match(document.styles[0].css, /\.dsp-hover__text\{[^}]*text-overflow:ellipsis/)
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
  const poller = loadClient().client.createPoller({
    sessionId: 'session-42',
    interval: 1000,
    fetchImpl: async (url) => {
      calls.push(url)
      return {
        ok: true,
        json: async () => ({ ok: true, items: [{ kind: 'command', text: 'ls' }, { kind: 'answer', text: 'done' }] }),
      }
    },
    setIntervalImpl: (fn) => {
      intervalCallback = fn
      return 7
    },
    clearIntervalImpl: (id) => { cleared = id },
    onItems: (items) => { calls.push(['items', items.map((item) => item.kind).join(',')]) },
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls[0], '/dsh-session-progress/tail?session=session-42&limit=4')
  assert.deepEqual(calls[1], ['items', 'command,answer'])

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
