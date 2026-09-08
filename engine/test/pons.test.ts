/**
 * The Pons and Uniswap v4 encodings, pinned to what Robinhood Chain mainnet
 * returned when they were verified. If any of these change, the live path
 * changes, and someone should look at the chain again before shipping.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import { decodeLaunchRecord, encodeCurveBuy, encodeV4SwapToBurn, explainRevert, poolId, poolKeyFor, PONS, sortCurrencies } from '../src/pons.js';
import type { Address } from '../src/types.js';
import { BURN_ADDRESS, NATIVE } from '../src/types.js';

/* getLaunchedToken(0x1fc0…) on mainnet: a graduated, ETH-paired launch. */
const TOKEN = '0x1fc0bd7022387a2d19e5cfa0d0a1cb365ec5fa41' as Address;
const RECORD = '0x' + [
  '0000000000000000000000001fc0bd7022387a2d19e5cfa0d0a1cb365ec5fa41',
  '000000000000000000000000be07402df24da9bd4a7a3e557ff8f7c9bb4dc91b',
  '000000000000000000000000a7c14bc0fba3a8d40af0b11354436878f172cead',
  '000000000000000000000000a7c14bc0fba3a8d40af0b11354436878f172cead',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000003a4965bf58a40000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000c8',
  '00000000000000000000000000000000000000000000000000000000000000c8',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000001',
].join('');

test('the factory record decodes to the curve, the creator recipient, the pair token and the tick spacing', () => {
  const r = decodeLaunchRecord(TOKEN, RECORD);
  assert.equal(r.exists, true);
  assert.equal(r.curve, '0xbe07402df24da9bd4a7a3e557ff8f7c9bb4dc91b');
  assert.equal(r.deployer, '0xa7c14bc0fba3a8d40af0b11354436878f172cead');
  assert.equal(r.creatorRecipient, '0xa7c14bc0fba3a8d40af0b11354436878f172cead');
  assert.equal(r.pairToken, NATIVE);
  assert.equal(r.tickSpacing, 200);
});

test('an unknown token decodes to a record that does not exist', () => {
  assert.equal(decodeLaunchRecord(TOKEN, '0x' + '00'.repeat(32 * 15)).exists, false);
  assert.equal(decodeLaunchRecord(TOKEN, '0x').exists, false);
});

test('the pool key reproduces the pool id the PoolManager emitted at initialisation', () => {
  const key = poolKeyFor(TOKEN, 200);
  assert.deepEqual(key, { currency0: NATIVE, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: PONS.hook });
  assert.equal(poolId(key), '0xfa9ae8733f61a9f87a3657d1d75a364f9c6450c8573ef806e0305c6884bc02c1');
});

test('currencies sort numerically, so native ETH is always currency0', () => {
  assert.deepEqual(sortCurrencies(TOKEN, NATIVE), [NATIVE, TOKEN]);
  assert.deepEqual(sortCurrencies(NATIVE, TOKEN), [NATIVE, TOKEN]);
});

test('the curve buy calldata uses the verified selector and carries the burn address', () => {
  const data = encodeCurveBuy(10n ** 15n, 42n, BURN_ADDRESS);
  assert.equal(data.slice(0, 10), '0x59a87bc1');
  assert.ok(data.toLowerCase().includes(BURN_ADDRESS.slice(2).toLowerCase()));
});

test('the v4 swap calldata is a Universal Router execute with V4_SWAP → swap, settle, take-to-burn', () => {
  const data = encodeV4SwapToBurn({ poolKey: poolKeyFor(TOKEN, 200), tokenOut: TOKEN, amountIn: 10n ** 15n, minOut: 1n, recipient: BURN_ADDRESS, deadline: 1_800_000_000 });
  const ur = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
  const parsed = ur.parseTransaction({ data });
  assert.ok(parsed);
  assert.equal(parsed.args[0], '0x10', 'one command: V4_SWAP');
  assert.equal(parsed.args[2], 1_800_000_000n);
  const [actions, params] = new Interface([]).getAbiCoder().decode(['bytes', 'bytes[]'], (parsed.args[1] as string[])[0]!) as unknown as [string, string[]];
  assert.equal(actions, '0x060c0e', 'SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE');
  assert.equal(params.length, 3);
  const [tokenOut, recipient, amount] = new Interface([]).getAbiCoder().decode(['address', 'address', 'uint256'], params[2]!) as unknown as [string, string, bigint];
  assert.equal(tokenOut.toLowerCase(), TOKEN);
  assert.equal(recipient.toLowerCase(), BURN_ADDRESS.toLowerCase());
  assert.equal(amount, 0n, 'OPEN_DELTA: the whole output');
});

test('the v4 encoder refuses a pool whose input side is not ETH', () => {
  const OTHER = '0x0000000000000000000000000000000000000001' as Address;
  assert.throws(() => encodeV4SwapToBurn({ poolKey: { currency0: OTHER, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: PONS.hook }, tokenOut: TOKEN, amountIn: 1n, minOut: 0n, recipient: BURN_ADDRESS, deadline: 0 }), /native ETH/);
});

test('known reverts are named', () => {
  assert.equal(explainRevert('0xc2caa2a6'), 'fee escrow: nothing to claim');
  assert.match(explainRevert('0x71c4efed' + '00'.repeat(64)) ?? '', /below minOut/);
  assert.equal(explainRevert('0x'), null);
  assert.equal(explainRevert(null), null);
});
