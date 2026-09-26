import type { Address, Hex } from 'viem'
import type { SignedOrder } from './fusion.ts'
import type { OrderRecord } from './relayer.ts'

export class RelayerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function relayerClient(baseUrl: string) {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
      ...init,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok) throw new RelayerError(res.status, body?.error ?? res.statusText)
    return body as T
  }
  const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

  return {
    health: () => call<{ ok: boolean }>('/health'),
    settings: () => call<{ resolvers: Address[]; settlement: Address; limitOrderProtocol: Address }>('/v1/settings'),
    submit: (o: SignedOrder) => call<{ orderHash: Hex }>('/v1/orders', { method: 'POST', body: json(o) }),
    active: () => call<{ items: OrderRecord[] }>('/v1/orders/active').then((r) => r.items),
    orders: (q = '') => call<{ items: OrderRecord[] }>(`/v1/orders${q}`).then((r) => r.items),
    report: (hash: Hex, report: NonNullable<OrderRecord['report']>) =>
      call(`/v1/orders/${hash}/report`, { method: 'POST', body: json(report) }),
    stats: () => call<{ orders: Record<string, number> }>('/v1/stats'),
  }
}

export type RelayerClient = ReturnType<typeof relayerClient>
