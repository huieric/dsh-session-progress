/**
 * Turn raw session log events into the few progress lines the hover card
 * shows. Pure functions only: no I/O, no services, so the host route and the
 * tests share exactly one implementation.
 *
 * Line kinds (rendered as the small leading label):
 *   user      - what the human just asked
 *   thinking  - assistant reasoning
 *   command   - a tool call, reduced to its most telling argument
 *   output    - the tool result
 *   answer    - assistant visible text
 *
 * Text keeps its newlines and is only cut at a generous budget, so the card can
 * wrap a long command or a multi-line tool result instead of ending it with an
 * ellipsis on the first visual line.
 */

/** Per-kind character budgets: wide enough that a normal line is never cut. */
const BUDGET = Object.freeze({
  user: 240,
  thinking: 400,
  command: 320,
  output: 520,
  answer: 640,
})

/** Hard cap on how many source lines one card row may occupy. */
const MAX_ITEM_LINES = 6

/** Line kinds, in render order. */
export const LINE_KINDS = Object.freeze(['user', 'thinking', 'command', 'output', 'answer'])

/** Cut a single-line string on code points so surrogate pairs survive. */
export function clip(text, max = BUDGET.command) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/**
 * Normalise card text: unify newlines, drop trailing blanks, fold runs of
 * blank lines, then cap by lines and characters. Only text that really
 * overflows the budget earns a trailing ellipsis.
 */
export function tidy(text, max = BUDGET.output, maxLines = MAX_ITEM_LINES) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const rows = []
  let cutByLine = false
  for (const raw of source.split('\n')) {
    const line = raw.replace(/[ \t]+$/g, '')
    if (rows.length === 0 && !line.trim()) continue
    // Collapse runs of blank lines into a single visual gap.
    if (rows.length > 0 && !line.trim() && !rows[rows.length - 1].trim()) continue
    if (rows.length >= maxLines) {
      cutByLine = true
      break
    }
    rows.push(line)
  }
  while (rows.length > 0 && !rows[rows.length - 1].trim()) rows.pop()

  let body = rows.join('\n').trim()
  if (!body) return ''
  const chars = Array.from(body)
  const cutByChar = chars.length > max
  if (cutByChar) body = chars.slice(0, Math.max(1, max - 1)).join('').replace(/\s+$/, '')
  if (cutByLine || cutByChar) body = `${body.replace(/…$/, '')}…`
  return body
}

function firstLine(text, max) {
  const line = String(text ?? '').split(/\r?\n/).find((entry) => entry.trim()) ?? ''
  return clip(tidy(line, max, 1), max)
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const ARGUMENT_KEYS = ['command', 'cmd', 'script', 'file_path', 'path', 'filePath', 'target', 'query', 'pattern', 'url', 'name']

/**
 * Reduce a tool call to one glanceable line: the shell command for bash-like
 * tools, the path for file tools, the query for search tools.
 */
export function describeToolCall(name, rawArguments) {
  const args = parseArguments(rawArguments)
  if (args) {
    for (const key of ARGUMENT_KEYS) {
      const value = args[key]
      if (typeof value !== 'string' || !value.trim()) continue
      return firstLine(value, BUDGET.command)
    }
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value.trim()) return firstLine(value, BUDGET.command)
    }
  }
  if (typeof rawArguments === 'string' && rawArguments.trim()) return firstLine(rawArguments, BUDGET.command)
  return name ? `${name}()` : ''
}

/** Concatenate the text parts of a message body, one part per line. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks = []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) chunks.push(part.text)
  }
  return chunks.join('\n')
}

/**
 * Walk events oldest -> newest and collect candidate lines.
 * Consecutive duplicates (the same command re-reported by both
 * `assistant/message` and `tool/call`) collapse into one.
 */
export function describeSessionProgress(events, options = {}) {
  const limit = normalizeLimit(options.limit)
  const lines = []
  const seenCalls = new Set()

  const push = (kind, text, extra) => {
    if (!text) return
    lines.push({ kind, text, ...extra })
  }

  for (const event of Array.isArray(events) ? events : []) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'user/message': {
        // v4 stores the user message directly on `data`, older rows nest it.
        push('user', tidy(messageText(data.message ?? data), BUDGET.user, 3))
        break
      }
      case 'assistant/message': {
        const content = data.message?.content
        if (!Array.isArray(content)) break
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'reasoning') {
            push('thinking', tidy(part.text, BUDGET.thinking))
          } else if (part.type === 'text') {
            push('answer', tidy(part.text, BUDGET.answer))
          } else if (part.type === 'tool-call') {
            if (part.id && seenCalls.has(part.id)) continue
            if (part.id) seenCalls.add(part.id)
            push('command', describeToolCall(part.name, part.arguments), { tool: safeToolName(part.name) })
          }
        }
        break
      }
      case 'tool/call': {
        if (data.callId && seenCalls.has(data.callId)) break
        if (data.callId) seenCalls.add(data.callId)
        push('command', describeToolCall(data.name, data.arguments), { tool: safeToolName(data.name) })
        break
      }
      case 'tool/result': {
        push('output', tidy(messageText(data.message), BUDGET.output))
        break
      }
      default:
        break
    }
  }

  const deduped = []
  for (const line of lines) {
    const previous = deduped[deduped.length - 1]
    if (previous && previous.kind === line.kind && previous.text === line.text) continue
    deduped.push(line)
  }

  return deduped.slice(-limit)
}

function safeToolName(name) {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : undefined
}

/** Clamp `limit` into a range the card can actually show. */
export function normalizeLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value)) return 4
  return Math.min(Math.max(Math.trunc(value), 1), 8)
}
