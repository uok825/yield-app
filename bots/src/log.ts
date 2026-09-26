/** Minimal structured logger: pretty for terminals, JSON lines when LOG_FORMAT=json. */
type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const COLORS: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }

const minLevel = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info
const json = process.env.LOG_FORMAT === 'json'

function serialize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return value.message
  return value
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export function logger(scope: string): Logger {
  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < minLevel) return
    const time = new Date().toISOString()
    if (json) {
      const entry: Record<string, unknown> = { time, level, scope, msg }
      for (const [k, v] of Object.entries(fields)) entry[k] = serialize(v)
      process.stdout.write(JSON.stringify(entry) + '\n')
      return
    }
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(serialize(v))}`)
      .join(' ')
    const line = `${time.slice(11, 19)} ${COLORS[level]}${level.padEnd(5)}\x1b[0m \x1b[1m${scope.padEnd(8)}\x1b[0m ${msg}${extra ? ' \x1b[90m' + extra + '\x1b[0m' : ''}`
    ;(level === 'error' ? process.stderr : process.stdout).write(line + '\n')
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  }
}
