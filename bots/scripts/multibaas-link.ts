/**
 * Links the deployed YieldSolver contracts to a MultiBaas deployment (Curvegrid), so its TX Explorer decodes our
 * transactions, Event Queries / webhooks see our events, and the AI agent can read them through the MultiBaas API /
 * MCP server. Read-only for our system: nothing on-chain changes. Idempotent.
 *
 *   MULTIBAAS_URL=https://<id>.multibaas.com MULTIBAAS_API_KEY=<admin key> npm run multibaas:link
 */
import '../src/env.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDeployment } from '../src/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../contracts/out')
const url = process.env.MULTIBAAS_URL?.replace(/\/$/, '')
const key = process.env.MULTIBAAS_API_KEY
if (!url || !key) throw new Error('MULTIBAAS_URL / MULTIBAAS_API_KEY missing in bots/.env')
const VERSION = '1.0'

async function mb(method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}/api/v0${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { status?: number; message?: string; result?: unknown }
  return { ok: res.ok, status: res.status, json }
}

const d = loadDeployment(84532)
const Z = '0x0000000000000000000000000000000000000000'
// Label (MultiBaas contract label = address alias) · Solidity artifact · deployed address
const targets: [string, string, string | undefined][] = [
  ['swapvm_router', 'YieldSwapVMRouter.sol/YieldSwapVMRouter.json', d.swapVMRouter],
  ['swapvm_resolver', 'SwapVMResolver.sol/SwapVMResolver.json', d.swapVMResolver],
  ['aqua', 'Aqua.sol/Aqua.json', d.aqua],
  ['aqua_yield_app', 'AquaYieldApp.sol/AquaYieldApp.json', d.aquaYieldApp],
  ['wallet_resolver', 'WalletResolver.sol/WalletResolver.json', d.walletResolver],
  ['carry_vault', 'CarryVault.sol/CarryVault.json', d.carryVault],
  ['yield_vault', 'YieldVault.sol/YieldVault.json', d.vault],
  ['yield_resolver', 'YieldResolver.sol/YieldResolver.json', d.resolver],
  ['limit_order_protocol', 'LimitOrderProtocol.sol/LimitOrderProtocol.json', d.limitOrderProtocol],
  ['inventory_vault', 'InventoryVault.sol/InventoryVault.json', d.inventoryVaults?.[1]],
]

for (const [label, artifact, address] of targets) {
  if (!address || address === Z) {
    console.log(`- ${label}: not deployed, skipped`)
    continue
  }
  const { abi, bytecode } = JSON.parse(readFileSync(join(out, artifact), 'utf8'))
  const contractName = artifact.split('/')[1].replace('.json', '')

  // 1. Contract (ABI) — create once.
  if (!(await mb('GET', `/contracts/${label}`)).ok) {
    const r = await mb('POST', `/contracts/${label}`, { label, contractName, version: VERSION, rawAbi: JSON.stringify(abi), bin: bytecode.object })
    if (!r.ok) throw new Error(`create ${label}: ${r.status} ${r.json.message}`)
  }
  // 2. Address alias.
  const a = await mb('GET', `/chains/ethereum/addresses/${label}`)
  if (!a.ok) {
    const r = await mb('POST', `/chains/ethereum/addresses`, { alias: label, address })
    if (!r.ok) throw new Error(`alias ${label}: ${r.status} ${r.json.message}`)
  }
  // 3. Link contract ↔ address with event sync from (near) now — the plan indexes at most 100 blocks back.
  const linked = ((a.json.result as any)?.contracts ?? []).some((c: any) => c.label === label)
  if (!linked) {
    const r = await mb('POST', `/chains/ethereum/addresses/${label}/contracts`, { label, version: VERSION, startingBlock: '-90' })
    if (!r.ok) throw new Error(`link ${label}: ${r.status} ${r.json.message}`)
  }
  console.log(`✓ ${label.padEnd(22)} ${contractName.padEnd(20)} ${address}`)
}
