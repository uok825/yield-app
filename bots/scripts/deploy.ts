/**
 * Deploys the contracts with the keys from bots/.env, so the private key never goes through your shell history:
 *   npm run deploy                 (RPC_URL from .env, e.g. Base Sepolia) — Deploy, DeployWallet, DeployCarry, DeploySwapVM
 *   npm run deploy -- wallet       only DeployWallet.s.sol (add self-custody mode to an existing deployment)
 *   npm run deploy -- carry        only DeployCarry.s.sol (add the conditional carry module)
 *   npm run deploy -- swapvm       only DeploySwapVM.s.sol (add 1inch SwapVM strategies over wallet liquidity)
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
const only = process.argv[2]
const scripts =
  only === 'wallet'
    ? ['DeployWallet.s.sol']
    : only === 'carry'
      ? ['DeployCarry.s.sol']
      : only === 'swapvm'
        ? ['DeploySwapVM.s.sol']
        : ['Deploy.s.sol', 'DeployWallet.s.sol', 'DeployCarry.s.sol', 'DeploySwapVM.s.sol']
for (const script of scripts) {
  console.log(`\n▶ ${script}`)
  const res = spawnSync(
    forge,
    ['script', `script/${script}`, '--rpc-url', rpc, '--private-key', deployer, '--broadcast', '--slow'],
    { cwd: join(here, '../../contracts'), env, stdio: 'inherit' },
  )
  if (res.status !== 0) process.exit(res.status ?? 1)
}
