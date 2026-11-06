/**
 * dsh-session-progress — Host half.
 *
 * Serves the last few progress lines of a session over one authenticated
 * same-origin route, so the browser hover card can render them without
 * touching session storage itself.
 *
 * Route: GET /dsh-session-progress/tail?session=<id>&limit=<1..8>
 *   { ok: true, session, source: 'live' | 'stored', eventCount, running,
 *     updatedAt, items: [{ kind, text, tool? }] }
 *
 * `running` is true while the session's newest logged turn is still open and
 * recent; the card uses it to poll faster and to show a live caret.
 *
 * Security: the route is not public. Every request must pass the same
 * Host/Origin + signed-cookie fence the rest of the Web API uses, and only ids
 * matching a strict charset are opened.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describeSessionProgress, normalizeLimit } from './tail.js'

/** Loader row identity, mirrored in cordis.patch.yml. */
export const name = 'session-progress'

/** Services this plugin needs before it activates. */
export const inject = ['webServer', 'connection']

export const VERSION = '0.2.0'

/** Exact route the browser polls while a session row is hovered. */
export const TAIL_PATH = '/dsh-session-progress/tail'

/** How many trailing events one lookup may scan. */
const SCAN_EVENTS = 240

/** Cache window for repeated polls of one session, in milliseconds. */
const CACHE_MS = 700

/** How recent the last event must be for an open turn to count as running. */
export const RUNNING_TTL_MS = 90000

/** Session ids we are willing to open. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function endRequest(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? configured : join(homedir(), '.dsh')
}

/**
 * Best-effort activation note written next to the DSH home, so an operator can
 * tell whether the host half loaded and was used. Deliberately content-free:
 * counters, pid and timestamps only — never a prompt, a command or a reply.
 */
export function createRecorder(file) {
  const state = {
    version: VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    requests: 0,
    failures: 0,
    lastRequestAt: null,
    lastSession: null,
  }
  let pending = null
  let dirty = false
  // Coalesce bursts: keep writing until no request landed while the file was
  // being written, so the note always reflects the latest counters.
  const drain = async () => {
    do {
      dirty = false
      const snapshot = `${JSON.stringify(state, null, 2)}\n`
      try {
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, snapshot, 'utf8')
      } catch {
        // A read-only home must not break the route.
      }
    } while (dirty)
  }
  const flush = () => {
    dirty = true
    if (!pending) pending = drain().finally(() => { pending = null })
    return pending
  }
  return {
    state,
    record(sessionId, failed) {
      state.requests += 1
      if (failed) state.failures += 1
      state.lastRequestAt = new Date().toISOString()
      state.lastSession = sessionId ? sessionId.slice(0, 64) : null
      void flush()
    },
    mark() { void flush() },
  }
}

/** Trailing events from a live session, when the host still holds it. */
function liveEvents(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const live = sessions?.get?.(sessionId)
  if (!live || !Number.isFinite(live.seq) || live.seq <= 0) return undefined
  if (typeof live.snapshotEvents !== 'function') return undefined
  const from = Math.max(0, live.seq - SCAN_EVENTS)
  let events
  try {
    events = live.snapshotEvents(from, live.seq)
  } catch {
    return undefined
  }
  if (!Array.isArray(events) || events.length === 0) return undefined
  return { events, eventCount: live.seq }
}

/** Trailing events from the on-disk ledger, for sessions nobody loaded. */
async function storedEvents(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.stat !== 'function') return undefined
  const stat = await persistence.stat(sessionId)
  if (!stat) return undefined
  const total = Number.isFinite(stat.eventCount) ? stat.eventCount : undefined
  const handle = await persistence.open(sessionId, 'read')
  try {
    const result = total === undefined
      ? await handle.read(0, Number.MAX_SAFE_INTEGER)
      : await handle.read(Math.max(0, total - SCAN_EVENTS), SCAN_EVENTS)
    const events = Array.isArray(result?.events) ? result.events : []
    return { events, eventCount: total ?? (events.at(-1)?.seq ?? events.length) }
  } finally {
    await handle.close?.()
  }
}

/**
 * Resolve the trailing events for one session, preferring the live gateway and
 * falling back to disk. `undefined` means the session is unknown.
 */
export async function loadTail(ctx, sessionId) {
  const live = liveEvents(ctx, sessionId)
  if (live) return { ...live, source: 'live' }
  const stored = await storedEvents(ctx, sessionId)
  if (stored) return { ...stored, source: 'stored' }
  return undefined
}

/**
 * Whether the trailing events of a session belong to a turn that is still
 * open: the newest `turn/start` has no `turn/end` after it, and the last event
 * is recent enough to be a live run rather than an interrupted one.
 */
export function isRunning(events, now = Date.now(), ttl = RUNNING_TTL_MS) {
  let open = false
  let newest = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start') open = true
    else if (event?.type === 'turn/end') open = false
    if (Number.isFinite(event?.time) && event.time > newest) newest = event.time
  }
  if (!open || newest <= 0) return false
  return now - newest < ttl
}

/** Build the JSON payload for one session. */
export async function describeTail(ctx, sessionId, limit, options = {}) {
  const resolved = await loadTail(ctx, sessionId)
  if (!resolved) return { ok: false, error: 'unknown session', items: [] }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  let newest = 0
  for (const event of resolved.events) {
    if (Number.isFinite(event?.time) && event.time > newest) newest = event.time
  }
  return {
    ok: true,
    session: sessionId,
    source: resolved.source,
    eventCount: resolved.eventCount,
    running: isRunning(resolved.events, now),
    updatedAt: newest > 0 ? newest : now,
    items: describeSessionProgress(resolved.events, { limit }),
  }
}

/**
 * Build the route handler. `deps` exists for tests: `describe`, `record` and
 * `reject` can each be replaced without a running host.
 */
export function createTailHandler(ctx, deps = {}) {
  const describe = deps.describe ?? describeTail
  const record = deps.record ?? (() => {})
  const reject = deps.reject ?? ((req) => ctx.connection?.requestRejection?.(req))

  return async function tailHandler(req, res) {
    const rejection = reject(req)
    if (rejection !== undefined) {
      endRequest(res, rejection, 'unauthorized')
      return
    }
    if (req.method !== 'GET') {
      endRequest(res, 405, 'method not allowed')
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      endRequest(res, 400, 'bad request')
      return
    }
    const sessionId = url.searchParams.get('session') ?? ''
    if (!SESSION_ID.test(sessionId)) {
      record(sessionId, true)
      sendJson(res, 400, { ok: false, error: 'invalid session id', items: [] })
      return
    }
    const limit = normalizeLimit(url.searchParams.get('limit') ?? '4')
    try {
      const payload = await describe(ctx, sessionId, limit)
      record(sessionId, !payload.ok)
      sendJson(res, payload.ok ? 200 : 404, payload)
    } catch (error) {
      record(sessionId, true)
      sendJson(res, 500, {
        ok: false,
        error: 'cannot read session',
        message: String(error?.message ?? error),
        items: [],
      })
    }
  }
}

/**
 * Cheap change stamp: the live sequence number when the host still holds the
 * session, else the ledger's event count. Serving from cache is then safe
 * until new events land, without a wall-clock window that can hand back stale
 * lines while the session is actively running.
 */
export async function eventStamp(ctx, sessionId) {
  const live = ctx.get('sessions')?.get?.(sessionId)
  if (live && Number.isFinite(live.seq) && live.seq > 0) return `live:${live.seq}`
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.stat !== 'function') return undefined
  try {
    const stat = await persistence.stat(sessionId)
    return stat ? `stored:${stat.eventCount ?? stat.revision ?? 'n/a'}` : undefined
  } catch {
    return undefined
  }
}

/** Tiny TTL cache so a hover poll does not re-read the ledger every tick. */
export function createCache(ttl = CACHE_MS) {
  const entries = new Map()
  return {
    async get(key, produce) {
      const hit = entries.get(key)
      const now = Date.now()
      if (hit && now - hit.at < ttl) return hit.value
      const value = await produce()
      entries.set(key, { at: now, value })
      if (entries.size > 64) entries.delete(entries.keys().next().value)
      return value
    },
    clear() { entries.clear() },
    get size() { return entries.size },
  }
}

/** Register the route on the Web server. */
export function apply(ctx, config = {}) {
  const recorder = createRecorder(join(dshHome(), 'session-progress', 'status.json'))
  const cache = createCache(config.cacheMs ?? CACHE_MS)
  const describe = async (innerCtx, sessionId, limit) => {
    const stamp = await eventStamp(innerCtx, sessionId)
    if (stamp === undefined) return { ok: false, error: 'unknown session', items: [] }
    return cache.get(`${stamp}:${limit}`, () => describeTail(innerCtx, sessionId, limit))
  }

  const handler = createTailHandler(ctx, {
    describe,
    record: (sessionId, failed) => recorder.record(sessionId, failed),
  })

  recorder.mark()
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: TAIL_PATH, handler }),
    'session-progress: hover tail route',
  )
  return { recorder, cache, handler }
}
