/**
 * Deploys the contracts with the keys from bots/.env, so the private key never goes through your shell history:
 *   npm run deploy                 (RPC_URL from .env, e.g. Base Sepolia)
 * Keeper / operator roles are set to the addresses of KEEPER_PRIVATE_KEY / OPERATOR_PRIVATE_KEY.
 */
import '../src/env.ts'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const here = dirname(fileURLToPath(import.meta.url))
const need = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} missing in bots/.env`)
  return v
}
const forge = [join(homedir(), '.foundry/bin/forge'), 'forge'].find((f) => spawnSync(f, ['--version']).status === 0)
if (!forge) throw new Error('forge not found — install Foundry (https://getfoundry.sh)')

const deployer = need('DEPLOYER_PRIVATE_KEY') as Hex
const env = {
  ...process.env,
  KEEPER: privateKeyToAccount(need('KEEPER_PRIVATE_KEY') as Hex).address,
  OPERATOR: privateKeyToAccount(need('OPERATOR_PRIVATE_KEY') as Hex).address,
}
const rpc = need('RPC_URL').split(',')[0].trim() // forge takes one endpoint; use the preferred one
console.log(`deployer ${privateKeyToAccount(deployer).address} → ${rpc}`)
const res = spawnSync(
  forge,
  ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--private-key', deployer, '--broadcast', '--slow', ...process.argv.slice(2)],
  { cwd: join(here, '../../contracts'), env, stdio: 'inherit' },
)
process.exit(res.status ?? 1)
