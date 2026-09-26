import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress, type Address } from 'viem'
import { Address as OneInchAddress } from '@1inch/fusion-sdk'
import { buildOrderTypedData } from '@1inch/limit-order-sdk'
import { decodeOrder, fillCalldata, newFusionOrder, orderHash, signOrder, takingAmountAt, type Domain } from '../src/fusion.ts'

const maker = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
const domain: Domain = {
  name: '1inch Limit Order Protocol',
  version: '4',
  chainId: 84532,
  verifyingContract: '0x1111111111111111111111111111111111111111',
}
const resolver = '0x2222222222222222222222222222222222222222' as Address
const other = '0x3333333333333333333333333333333333333333' as Address

function order(start = 1_000_000n) {
  return newFusionOrder({
    settlement: '0x4444444444444444444444444444444444444444',
    resolvers: [resolver],
    maker: maker.address,
    makerAsset: '0x5555555555555555555555555555555555555555',
    takerAsset: '0x6666666666666666666666666666666666666666',
    makingAmount: 3_000_000_000n,
    minTakingAmount: 990_000_000_000_000_000n,
    initialRateBump: 151_515, // +1.5%
    auctionStart: start,
    auctionDuration: 120n,
  })
}

describe('fusion orders', () => {
  it('signs with a custom LOP domain and round-trips through JSON', async () => {
    const o = order()
    const signed = await signOrder(maker, domain, o)
    expect(signed.orderHash).toBe(orderHash(domain, o))

    const wire = JSON.parse(JSON.stringify(signed))
    const back = decodeOrder(wire)
    expect(orderHash(domain, back)).toBe(signed.orderHash)

    const td = buildOrderTypedData(domain.chainId, domain.verifyingContract, domain.name, domain.version, back.build())
    const signer = await recoverTypedDataAddress({
      domain: td.domain as any,
      types: { Order: td.types.Order } as any,
      primaryType: 'Order',
      message: td.message as any,
      signature: signed.signature,
    })
    expect(signer).toBe(maker.address)
  })

  it('decays the taking amount from the premium to the minimum', () => {
    const o = order(1_000n)
    const atStart = takingAmountAt(o, resolver, 1_000n)
    const mid = takingAmountAt(o, resolver, 1_060n)
    const end = takingAmountAt(o, resolver, 1_120n)
    expect(atStart).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(end)
    expect(end).toBe(990_000_000_000_000_000n)
    expect(Number(atStart) / Number(end)).toBeCloseTo(1.0151515, 5)
  })

  it('only whitelists the configured resolver', () => {
    const o = order(1_000n)
    expect(o.canExecuteAt(new OneInchAddress(resolver), 1_050n)).toBe(true)
    expect(o.canExecuteAt(new OneInchAddress(other), 1_050n)).toBe(false)
  })

  it('builds fillOrderArgs calldata', async () => {
    const o = order()
    const signed = await signOrder(maker, domain, o)
    const data = fillCalldata(o, signed.signature, 1n)
    expect(data.slice(0, 10)).toBe('0xf497df75') // LimitOrderProtocol.fillOrderArgs
  })
})
