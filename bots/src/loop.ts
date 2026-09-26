import { logger } from './log.ts'
import { sleep } from './chain.ts'

export interface BotStatus {
  name: string
  startedAt: number
  lastRunAt?: number
  lastOkAt?: number
  lastError?: string
  runs: number
  errors: number
  counters: Record<string, number>
}

/** In-process registry exposed by the relayer's /v1/bots and each bot's health endpoint. */
export const statuses = new Map<string, BotStatus>()

export function status(name: string): BotStatus {
  let s = statuses.get(name)
  if (!s) {
    s = { name, startedAt: Date.now(), runs: 0, errors: 0, counters: {} }
    statuses.set(name, s)
  }
  return s
}

export function count(name: string, key: string, by = 1) {
  const s = status(name)
  s.counters[key] = (s.counters[key] ?? 0) + by
}

/**
 * Runs `tick` sequentially every `intervalMs` until `signal` aborts. Errors are logged and back off exponentially
 * (up to 8× the interval) so a flaky RPC doesn't spin.
 */
export async function runEvery(name: string, intervalMs: number, signal: AbortSignal, tick: () => Promise<void>) {
  const log = logger(name)
  const s = status(name)
  let failures = 0
  while (!signal.aborted) {
    s.lastRunAt = Date.now()
    s.runs++
    try {
      await tick()
      s.lastOkAt = Date.now()
      s.lastError = undefined
      failures = 0
    } catch (err) {
      failures++
      s.errors++
      s.lastError = err instanceof Error ? err.message : String(err)
      log.error('tick failed', { error: s.lastError, failures })
    }
    const wait = intervalMs * Math.min(2 ** Math.max(0, failures - 1), 8)
    await Promise.race([sleep(wait), new Promise((r) => signal.addEventListener('abort', r, { once: true }))])
  }
}
