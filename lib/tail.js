/**
 * Turn raw session log events into the few short progress lines the hover card
 * shows. Pure functions only: no I/O, no services, so the host route and the
 * tests share exactly one implementation.
 *
 * Line kinds (rendered as the small leading label):
 *   user      - what the human just asked
 *   thinking  - assistant reasoning
 *   command   - a tool call, reduced to its most telling argument
 *   output    - the tool result
 *   answer    - assistant visible text
 */

/** Longest single line we hand to the card; CSS ellipsis trims the rest. */
const MAX_TEXT = 120

/** Line kinds, in render order. */
export const LINE_KINDS = Object.freeze(['user', 'thinking', 'command', 'output', 'answer'])

/** Collapse whitespace and cut on code points so surrogate pairs survive. */
export function clip(text, max = MAX_TEXT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const chars = Array.from(flat)
  if (chars.length <= max) return flat
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

function firstLine(text, max) {
  const line = String(text ?? '').split(/\r?\n/).find((entry) => entry.trim()) ?? ''
  return clip(line, max)
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
      return firstLine(value, MAX_TEXT)
    }
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value.trim()) return firstLine(value, MAX_TEXT)
    }
  }
  if (typeof rawArguments === 'string' && rawArguments.trim()) return firstLine(rawArguments, MAX_TEXT)
  return name ? `${name}()` : ''
}

/** Concatenate the text parts of a message body. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks = []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) chunks.push(part.text)
  }
  return chunks.join(' ')
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
        push('user', clip(messageText(data.message), 140))
        break
      }
      case 'assistant/message': {
        const content = data.message?.content
        if (!Array.isArray(content)) break
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'reasoning') {
            push('thinking', clip(part.text, 140))
          } else if (part.type === 'text') {
            push('answer', clip(part.text, 140))
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
        push('output', clip(messageText(data.message), 140))
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
