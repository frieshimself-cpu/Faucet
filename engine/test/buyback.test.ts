import assert from 'node:assert/strict';
import test from 'node:test';
import { BuybackError, assertPlanConserved, execute, plan } from '../src/buyback.js';
import { CONFIG, assertPolicyBalanced, ROUTING, type FaucetConfig } from '../src/config.js';
import { MockChain, tokensTransferredTo } from '../src/evm.js';
import { assertReceiptConserved, toSiteData } from '../src/ledger.js';
import type { Address } from '../src/types.js';
import { BURN_ADDRESS } from '../src/types.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const ROUTER = '0x3333333333333333333333333333333333333333' as Address;
const WETH = '0x4444444444444444444444444444444444444444' as Address;
const ETH = 10n ** 18n;

function chainWith(balance: bigint, extra: Partial<ConstructorParameters<typeof MockChain>[0]> = {}): MockChain {
  return new MockChain({
    wallet: WALLET, token: TOKEN, burnAddress: BURN_ADDRESS, balance,
    tokensPerWei: 40_000n, impactPer1e18: 20_000_000_000_000_000n,
    totalSupply: 1_000_000_000n * ETH, executionDriftBps: 50, ...extra,
  });
}

const overrides = { wallet: WALLET, token: TOKEN, router: ROUTER, weth: WETH };

test('the shipped policy routes exactly 100% to buyback', () => {
  assert.doesNotThrow(() => assertPolicyBalanced(ROUTING));
  assert.equal(ROUTING.rules.length, 1);
  assert.equal(ROUTING.rules[0]?.bucket, 'buyback');
  assert.equal(ROUTING.rules[0]?.bps, 10_000);
});

test('a plan spends everything above the gas reserve, and only that', async () => {
  const chain = chainWith(ETH / 10n); // 0.1 ETH
  const result = await plan({ config: CONFIG, chain, ...overrides, now: () => 1_000 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.spend + result.plan.gasReserve, result.plan.balance);
  assert.equal(result.plan.spend, ETH / 10n - CONFIG.limits.gasReserveWei);
  assert.equal(result.plan.to, BURN_ADDRESS);
  assert.deepEqual(result.plan.path, [WETH, TOKEN]);
  assert.equal(result.plan.deadline, 1_000 + CONFIG.limits.deadlineSeconds);
});

test('minOut is the quote less the configured slippage', async () => {
  const chain = chainWith(ETH / 10n);
  const result = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const expected = (result.plan.expectedOut * BigInt(10_000 - CONFIG.limits.slippageBps)) / 10_000n;
  assert.equal(result.plan.minOut, expected);
});

test('a wallet under the floor is left alone', async () => {
  const chain = chainWith(CONFIG.limits.gasReserveWei + CONFIG.limits.minBuybackWei - 1n);
  const result = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'below-floor');
  assert.ok(!chain.calls.some((c) => c.startsWith('swap')), 'nothing may be sent');
});

test('an empty wallet does not underflow the reserve', async () => {
  const chain = chainWith(0n);
  const result = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'below-floor');
  assert.equal(result.skip.spendable, 0n);
});

test('an unconfigured engine refuses to plan rather than guessing', async () => {
  const chain = chainWith(ETH);
  const result = await plan({ config: CONFIG, chain, wallet: WALLET, token: TOKEN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'unconfigured');
  assert.deepEqual(result.skip.missing, ['router', 'weth']);
  assert.equal(chain.calls.length, 0);
});

test('execute sends the swap straight to the burn address and accounts for every wei', async () => {
  const chain = chainWith(ETH / 10n);
  const planned = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;

  const receipt = await execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'mock', router: ROUTER, token: TOKEN });
  assert.equal(receipt.ethSpent, planned.plan.spend);
  assert.equal(receipt.tokensBurned, chain.burned);
  assert.ok(receipt.tokensBurned >= planned.plan.minOut);
  assert.equal(receipt.balanceBefore - receipt.ethSpent - receipt.gasCost, receipt.balanceAfter);
  assert.doesNotThrow(() => assertReceiptConserved(receipt));
  assert.ok(chain.calls.some((c) => c === `swap:${planned.plan.spend}:${BURN_ADDRESS}`));
});

test('a swap that falls below minOut reverts and the engine reports it, spending only gas', async () => {
  const chain = chainWith(ETH / 10n, { executionDriftBps: CONFIG.limits.slippageBps + 100 });
  const planned = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const before = await chain.balance(WALLET);
  await assert.rejects(
    execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'mock', router: ROUTER, token: TOKEN }),
    (e: unknown) => e instanceof BuybackError && /reverted/.test(e.message),
  );
  const after = await chain.balance(WALLET);
  assert.ok(before - after < CONFIG.limits.gasReserveWei, 'only gas may be lost on a revert');
  assert.equal(chain.burned, 0n);
});

test('a plan whose recipient is not the burn address is refused', () => {
  assert.throws(
    () => assertPlanConserved({
      wallet: WALLET, balance: 10n, gasReserve: 2n, spend: 8n, expectedOut: 100n, minOut: 97n,
      slippageBps: 300, path: [WETH, TOKEN], to: WALLET, deadline: 0, quotedAtBlock: 0,
    }),
    /not the burn address/,
  );
});

test('a plan that does not account for the whole balance is refused', () => {
  assert.throws(
    () => assertPlanConserved({
      wallet: WALLET, balance: 10n, gasReserve: 2n, spend: 7n, expectedOut: 100n, minOut: 97n,
      slippageBps: 300, path: [WETH, TOKEN], to: BURN_ADDRESS, deadline: 0, quotedAtBlock: 0,
    }),
    /leaks/,
  );
});

test('tokensTransferredTo sums only Transfer logs for the token that land on the burn address', () => {
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const amount = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  const logs = [
    { address: TOKEN, topics: [topic, pad(ROUTER), pad(BURN_ADDRESS)], data: amount(500n) },
    { address: TOKEN, topics: [topic, pad(ROUTER), pad(WALLET)], data: amount(999n) },      // not to burn
    { address: WETH, topics: [topic, pad(WALLET), pad(BURN_ADDRESS)], data: amount(777n) }, // wrong token
    { address: TOKEN, topics: [topic, pad(WALLET), pad(BURN_ADDRESS)], data: amount(25n) },
  ];
  assert.equal(tokensTransferredTo(logs, TOKEN, BURN_ADDRESS), 525n);
});

test('a multi-cycle run never leaks and the site data adds up', async () => {
  const chain = chainWith(0n);
  const receipts = [];
  for (let i = 1; i <= 8; i++) {
    chain.credit(ETH / 50n + BigInt(i) * 10n ** 15n);
    const planned = await plan({ config: CONFIG, chain, ...overrides });
    if (!planned.ok) continue;
    const r = await execute({ config: CONFIG, chain, plan: planned.plan, id: i, mode: 'mock', router: ROUTER, token: TOKEN });
    assertReceiptConserved(r);
    receipts.push(r);
  }
  assert.ok(receipts.length >= 7);

  const data = toSiteData(CONFIG as FaucetConfig, { receipts }, await chain.tokenTotalSupply());
  assert.equal(BigInt(data.totals.tokensBurnedRaw), chain.burned);
  assert.equal(BigInt(data.totals.ethSpentRaw), receipts.reduce((s, r) => s + r.ethSpent, 0n));
  assert.equal(data.totals.burns, receipts.length);
  assert.match(data.totals.supplyBurnedPct ?? '', /%$/);
});
