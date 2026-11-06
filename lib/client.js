/**
 * dsh-session-progress — browser half.
 *
 * Registers one section in the sidebar session row's hover card (the slot the
 * card exposes between its relative time and its trailing status line) and
 * renders the session's last few progress lines: thinking, command, output,
 * reply. Data comes from the plugin's own Host route, polled while the card is
 * open and dropped the moment it closes.
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

    /** Poll cadence while the hover card stays open. */
    var POLL_MS = 1200

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

    var CSS = [
      '.dsp-hover{display:flex;flex-direction:column;gap:3px;margin-top:3px;min-width:0;max-width:264px}',
      '.dsp-hover__row{display:flex;align-items:baseline;gap:10px;min-width:0;font-size:12px;line-height:15px}',
      '.dsp-hover__label{flex:none;min-width:32px;font-size:10px;line-height:15px;opacity:.5;letter-spacing:.02em;text-transform:uppercase;white-space:nowrap}',
      '.dsp-hover__text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}',
      '.dsp-hover__text--thinking{opacity:.62}',
      '.dsp-hover__text--output{opacity:.62;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.dsp-hover__text--command{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.dsp-hover__row--user .dsp-hover__text{opacity:.72}',
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
     * once immediately, then on an interval, and stop on request or after too
     * many consecutive failures.
     */
    function createPoller(options) {
      var opts = options || {}
      var sessionId = opts.sessionId
      var endpoint = opts.endpoint || ENDPOINT
      var limit = opts.limit || LIMIT
      var interval = opts.interval || POLL_MS
      var maxFailures = opts.maxFailures || MAX_FAILURES
      var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null)
      var setIntervalImpl = opts.setIntervalImpl || setInterval
      var clearIntervalImpl = opts.clearIntervalImpl || clearInterval
      var onItems = opts.onItems || function () {}
      var onFailure = opts.onFailure || function () {}

      var valid = typeof sessionId === 'string' && SESSION_ID.test(sessionId)
      var alive = valid
      var failures = 0
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
            var items = normalizeItems(payload)
            if (items.length > 0) onItems(items)
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
        timer = setIntervalImpl(tick, interval)
      }

      return {
        stop: stop,
        tick: tick,
        get failures() { return failures },
        get running() { return alive },
      }
    }

    /** Build the four-ish text rows the card shows. */
    function renderLines(items, t) {
      if (!items || items.length === 0) return null
      var rows = []
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index]
        rows.push(h('div', {
          key: 'line-' + index,
          className: 'dsp-hover__row dsp-hover__row--' + item.kind,
          title: item.text,
        }, [
          h('span', { key: 'label', className: 'dsp-hover__label' }, t(item.kind)),
          h('span', { key: 'text', className: 'dsp-hover__text dsp-hover__text--' + item.kind }, item.text),
        ]))
      }
      return h('div', { className: 'dsp-hover' }, rows)
    }

    /**
     * One section of the hover card. `sessionId` is the slot owner's only prop;
     * `t` comes from the locale dictionary registered for this namespace.
     */
    function SessionProgressHover(props) {
      var sessionId = props && props.sessionId
      var t = props && typeof props.t === 'function' ? props.t : function (key) { return key }
      var pair = React.useState(null)
      var items = pair[0]
      var setItems = pair[1]

      React.useEffect(function () {
        if (!sessionId) return undefined
        var poller = createPoller({
          sessionId: sessionId,
          interval: POLL_MS,
          limit: LIMIT,
          onItems: function (next) {
            setItems(function (previous) { return sameItems(previous, next) ? previous : next })
          },
        })
        return function () { poller.stop() }
      }, [sessionId])

      return renderLines(items, t)
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
    exports.LIMIT = LIMIT
    exports.DICT = DICT
    exports.createPoller = createPoller
    exports.normalizeItems = normalizeItems
    exports.renderLines = renderLines
    exports.SessionProgressHover = SessionProgressHover
    return module.exports
  },
})
