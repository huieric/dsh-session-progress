/**
 * dsh-session-progress — browser half.
 *
 * Registers one section in the sidebar session row's hover card (the slot the
 * card exposes between its relative time and its trailing status line) and
 * renders the session's last few progress lines: thinking, command, output,
 * reply. Data comes from the plugin's own Host route, polled while the card is
 * open and dropped the moment it closes.
 *
 * The card follows the run: while the Host reports the turn as still open the
 * poll tightens and the newest line carries a blinking caret, so hovering a
 * running session feels like watching it work instead of staring at a frozen
 * snapshot.
 *
 * The module is shipped verbatim to the browser, so it keeps the plain
 * lazy-CJS shape the client module loader expects: no imports, no bundler.
 */
;(function boot(entry) {
  var registry = window.__ModuleLoader__
  if (!registry || typeof registry.load !== 'function') {
    console.warn('[session-progress] client module loader is unavailable')
    return
  }
  registry.load(entry)
})({
  id: 'dsh-session-progress',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    /** Locale namespace, mirrored by `locale:` in the slot registration. */
    var NS = 'session-progress'

    /** Host route registered by lib/index.js. */
    var ENDPOINT = '/dsh-session-progress/tail'

    /** Poll cadence while the hover card stays open on an idle session. */
    var POLL_MS = 1800

    /** Tighter cadence while the session's turn is still open. */
    var LIVE_POLL_MS = 600

    /** Consecutive failures after which polling gives up for this hover. */
    var MAX_FAILURES = 3

    /** How many lines the card shows. */
    var LIMIT = 4

    /** Ids match the Host validator. */
    var SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

    var DICT = {
      zh: {
        thinking: '思考',
        command: '命令',
        output: '输出',
        answer: '回复',
        user: '你',
        unavailable: '进度不可用',
      },
      en: {
        thinking: 'Think',
        command: 'Run',
        output: 'Out',
        answer: 'Reply',
        user: 'You',
        unavailable: 'Unavailable',
      },
    }

    /*
     * The Host card is 244px wide by default. That leaves ~212px for text, so
     * every long command ended in an ellipsis. `:has()` lets this section reach
     * the two wrappers above it and ask for a wider card; browsers without
     * support simply keep the default width and the text wraps there instead.
     */
    var CSS = [
      '.dsp-hover{display:flex;flex-direction:column;gap:6px;margin-top:5px;min-width:0;width:100%;max-width:340px}',
      '.dsp-hover__row{display:grid;grid-template-columns:34px minmax(0,1fr);column-gap:10px;align-items:start;min-width:0;font-size:12px;line-height:16px}',
      '.dsp-hover__label{font-size:10px;line-height:16px;opacity:.5;letter-spacing:.02em;text-transform:uppercase;white-space:nowrap;padding-top:1px}',
      '.dsp-hover__text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;opacity:.9}',
      '.dsp-hover__text--thinking{opacity:.66}',
      '.dsp-hover__text--output{opacity:.66;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:15px}',
      '.dsp-hover__text--command{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:15px}',
      '.dsp-hover__row--user .dsp-hover__text{opacity:.74}',
      '.dsp-hover__row--fresh{animation:dsp-in .18s ease-out}',
      '.dsp-hover__caret{display:inline-block;width:.42em;height:.95em;margin-left:2px;vertical-align:-.08em;background:currentColor;opacity:.5;animation:dsp-blink 1.1s steps(2,start) infinite}',
      '.dsp-hover--live .dsp-hover__row:last-child .dsp-hover__label{opacity:.75}',
      '@keyframes dsp-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
      '@keyframes dsp-blink{50%{opacity:0}}',
      '@media (prefers-reduced-motion: reduce){.dsp-hover__row--fresh{animation:none}.dsp-hover__caret{animation:none}}',
      'div:has(> .dsp-hover){width:auto;max-width:none}',
      'div:has(> div > .dsp-hover){width:372px;max-width:372px;min-width:372px}',
      'div:has(> div > div > .dsp-hover){width:372px;max-width:372px;min-width:372px}',
    ].join('')

    var STYLE_TAG = 'dsh-session-progress/hover.css'

    function injectStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.head.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]')) return
      var style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_TAG)
      style.setAttribute('data-plugin', 'dsh-session-progress')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Keep only well-formed lines from a Host payload. */
    function normalizeItems(payload) {
      if (!payload || payload.ok !== true || !Array.isArray(payload.items)) return []
      var items = []
      for (var index = 0; index < payload.items.length; index += 1) {
        var item = payload.items[index]
        if (!item || typeof item.text !== 'string' || !item.text) continue
        items.push({
          kind: typeof item.kind === 'string' ? item.kind : 'answer',
          text: item.text,
        })
      }
      return items
    }

    function sameItems(left, right) {
      if (left === right) return true
      if (!left || !right || left.length !== right.length) return false
      for (var index = 0; index < left.length; index += 1) {
        if (left[index].kind !== right[index].kind || left[index].text !== right[index].text) return false
      }
      return true
    }

    /**
     * The poll loop, extracted from React so it can be driven by tests: fetch
     * once immediately, then on an interval. While the Host reports an open
     * turn the interval tightens; when the turn ends it relaxes again.
     */
    function createPoller(options) {
      var opts = options || {}
      var sessionId = opts.sessionId
      var endpoint = opts.endpoint || ENDPOINT
      var limit = opts.limit || LIMIT
      var interval = opts.interval || POLL_MS
      var liveInterval = opts.liveInterval || LIVE_POLL_MS
      var maxFailures = opts.maxFailures || MAX_FAILURES
      var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null)
      var setIntervalImpl = opts.setIntervalImpl || setInterval
      var clearIntervalImpl = opts.clearIntervalImpl || clearInterval
      var onState = opts.onState || function () {}
      var onFailure = opts.onFailure || function () {}

      var valid = typeof sessionId === 'string' && SESSION_ID.test(sessionId)
      var alive = valid
      var failures = 0
      var running = false
      var delay = interval
      var timer = null
      var controller = null

      function stop() {
        alive = false
        if (timer !== null) {
          clearIntervalImpl(timer)
          timer = null
        }
        if (controller) {
          try { controller.abort() } catch { /* already settled */ }
          controller = null
        }
      }

      function retime(nextRunning) {
        running = nextRunning === true
        var next = running ? liveInterval : interval
        if (next === delay || !alive || !valid) return
        delay = next
        if (timer !== null) clearIntervalImpl(timer)
        timer = setIntervalImpl(tick, delay)
      }

      function tick() {
        if (!alive || !valid) return Promise.resolve()
        if (!fetchImpl) {
          stop()
          return Promise.resolve()
        }
        try {
          controller = typeof AbortController === 'function' ? new AbortController() : null
        } catch {
          controller = null
        }
        var url = endpoint + '?session=' + encodeURIComponent(sessionId) + '&limit=' + limit
        return Promise.resolve(fetchImpl(url, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
        }))
          .then(function (response) {
            if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '?'))
            return response.json()
          })
          .then(function (payload) {
            if (!alive) return
            failures = 0
            retime(payload && payload.running === true)
            onState(normalizeItems(payload), running)
          })
          .catch(function (error) {
            if (!alive) return
            failures += 1
            onFailure(error)
            if (failures >= maxFailures) stop()
          })
      }

      if (valid) {
        void tick()
        timer = setIntervalImpl(tick, delay)
      }

      return {
        stop: stop,
        tick: tick,
        get failures() { return failures },
        get running() { return alive },
        get live() { return running },
        get delay() { return delay },
      }
    }

    /** Build the text rows the card shows; the newest one carries the caret. */
    function renderLines(items, t, running) {
      if (!items || items.length === 0) return null
      var rows = []
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index]
        var last = index === items.length - 1
        var children = [
          h('span', { key: 'label', className: 'dsp-hover__label' }, t(item.kind)),
          h('span', { key: 'text', className: 'dsp-hover__text dsp-hover__text--' + item.kind }, [
            item.text,
            running && last ? h('span', { key: 'caret', className: 'dsp-hover__caret' }) : null,
          ]),
        ]
        rows.push(h('div', {
          // The key carries the text so a line that grows remounts and replays
          // the fade-in: visible motion exactly where new output arrived.
          key: 'line-' + index + '-' + item.kind + '-' + item.text.length,
          className: 'dsp-hover__row dsp-hover__row--' + item.kind + (last ? ' dsp-hover__row--fresh' : ''),
          title: item.text,
        }, children))
      }
      return h('div', { className: 'dsp-hover' + (running ? ' dsp-hover--live' : '') }, rows)
    }

    /**
     * One section of the hover card. `sessionId` is the slot owner's only prop;
     * `t` comes from the locale dictionary registered for this namespace.
     */
    function SessionProgressHover(props) {
      var sessionId = props && props.sessionId
      var t = props && typeof props.t === 'function' ? props.t : function (key) { return key }
      var state = React.useState({ items: null, running: false })
      var view = state[0]
      var setView = state[1]

      React.useEffect(function () {
        if (!sessionId) return undefined
        var poller = createPoller({
          sessionId: sessionId,
          interval: POLL_MS,
          liveInterval: LIVE_POLL_MS,
          limit: LIMIT,
          onState: function (next, live) {
            setView(function (previous) {
              if (previous.items && sameItems(previous.items, next) && previous.running === live) return previous
              return { items: next.length > 0 ? next : previous.items, running: live }
            })
          },
        })
        return function () { poller.stop() }
      }, [sessionId])

      return renderLines(view.items, t, view.running)
    }

    var inject = ['slots', 'locale']

    function apply(ctx) {
      injectStyle()
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT)
      }, 'session-progress: locale')
      ctx.slots.inject('sidebar.session.row.hover', function () {
        return ctx.slots.register({
          name: 'sidebar.session.row.hover',
          id: 'session-progress',
          order: 20,
          label: 'Session progress',
          locale: NS,
        }, SessionProgressHover)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.ENDPOINT = ENDPOINT
    exports.POLL_MS = POLL_MS
    exports.LIVE_POLL_MS = LIVE_POLL_MS
    exports.LIMIT = LIMIT
    exports.DICT = DICT
    exports.createPoller = createPoller
    exports.normalizeItems = normalizeItems
    exports.renderLines = renderLines
    exports.SessionProgressHover = SessionProgressHover
    return module.exports
  },
})
