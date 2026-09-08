import assert from 'node:assert/strict';
import test from 'node:test';
import { BuybackError, assertPlanConserved, claimRewards, execute, plan, routeFor } from '../src/buyback.js';
import { CONFIG, assertPolicyBalanced, ROUTING } from '../src/config.js';
import { MockChain, tokensTransferredTo } from '../src/evm.js';
import { assertReceiptConserved, toSiteData } from '../src/ledger.js';
import type { Address, ClaimReceipt, Route } from '../src/types.js';
import { BURN_ADDRESS, NATIVE } from '../src/types.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const CURVE = '0x5555555555555555555555555555555555555555' as Address;
const ETH = 10n ** 18n;
const ROUTE: Route = { kind: 'pons-curve', curve: CURVE };

function chainWith(balance: bigint, extra: Partial<ConstructorParameters<typeof MockChain>[0]> = {}): MockChain {
  return new MockChain({
    wallet: WALLET, token: TOKEN, burnAddress: BURN_ADDRESS, balance,
    tokensPerWei: 40_000n, impactPer1e18: 20_000_000_000_000_000n,
    totalSupply: 1_000_000_000n * ETH, executionDriftBps: 50, ...extra,
  });
}

const overrides = { wallet: WALLET, token: TOKEN };

test('the shipped policy routes exactly 100% to buyback', () => {
  assert.doesNotThrow(() => assertPolicyBalanced(ROUTING));
  assert.equal(ROUTING.rules.length, 1);
  assert.equal(ROUTING.rules[0]?.bucket, 'buyback');
  assert.equal(ROUTING.rules[0]?.bps, 10_000);
});

test('the shipped config points at Robinhood Chain and the Pons v2 contracts', () => {
  assert.equal(CONFIG.chain.chainId, 4663);
  assert.match(CONFIG.chain.rpcUrl, /robinhood/);
  assert.equal(CONFIG.pons.feeEscrow, '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e');
  assert.equal(CONFIG.pons.factory, '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
  assert.ok(CONFIG.limits.minClaimWei > 0n);
  assert.equal(CONFIG.limits.intervalSeconds, 180);
});

test('claim: rewards in the escrow are pulled into the wallet, gas and all accounted for', async () => {
  const chain = chainWith(0n);
  chain.accrue(ETH / 20n);
  const result = await claimRewards({ config: CONFIG, chain, ...overrides, mode: 'mock' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.amount, ETH / 20n);
  assert.equal(await chain.balance(WALLET), ETH / 20n - result.receipt.gasCost);
  assert.equal(await chain.claimable(WALLET), 0n);
  assert.ok(chain.calls.some((c) => c.startsWith('claim:')));
});

test('claim: nothing claimable, or dust under the minimum, is left alone', async () => {
  const chain = chainWith(0n);
  const empty = await claimRewards({ config: CONFIG, chain, ...overrides, mode: 'mock' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.skip, 'nothing-claimable');

  chain.accrue(CONFIG.limits.minClaimWei - 1n);
  const dust = await claimRewards({ config: CONFIG, chain, ...overrides, mode: 'mock' });
  assert.equal(dust.ok, false);
  if (!dust.ok) assert.equal(dust.skip, 'below-minimum');
  assert.ok(!chain.calls.some((c) => c.startsWith('claim:')), 'nothing may be sent');
});

test('a plan spends everything above the gas reserve, and only that', async () => {
  const chain = chainWith(ETH / 10n); // 0.1 ETH
  const result = await plan({ config: CONFIG, chain, ...overrides, now: () => 1_000 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.spend + result.plan.gasReserve, result.plan.balance);
  assert.equal(result.plan.spend, ETH / 10n - CONFIG.limits.gasReserveWei);
  assert.equal(result.plan.to, BURN_ADDRESS);
  assert.deepEqual(result.plan.route, ROUTE);
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

test('a graduated launch is routed to its Uniswap v4 pool, with the Pons hook and sorted currencies', async () => {
  const chain = chainWith(ETH / 10n, { graduated: true });
  const result = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.route.kind, 'uniswap-v4');
  if (result.plan.route.kind !== 'uniswap-v4') return;
  assert.deepEqual(result.plan.route.poolKey, { currency0: NATIVE, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: CONFIG.pons.hook });
});

test('routeFor refuses what it cannot buy safely', () => {
  const base = { token: TOKEN, exists: true, curve: CURVE, deployer: WALLET, creatorRecipient: WALLET, pairToken: NATIVE, tickSpacing: 200, graduated: false, poolLiquidity: 0n };
  assert.deepEqual(routeFor(base, CONFIG.pons.hook), ROUTE);
  assert.match(String(routeFor({ ...base, exists: false }, CONFIG.pons.hook)), /not a Pons v2 launch/);
  assert.match(String(routeFor({ ...base, pairToken: TOKEN }, CONFIG.pons.hook)), /not ETH/);
  assert.match(String(routeFor({ ...base, graduated: true }, CONFIG.pons.hook)), /no liquidity/);
  assert.equal((routeFor({ ...base, graduated: true, poolLiquidity: 1n }, CONFIG.pons.hook) as Route).kind, 'uniswap-v4');
});

test('a token the factory does not know is a skip, not a guess', async () => {
  const chain = chainWith(ETH / 10n, { unknownToken: true });
  const result = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'no-route');
  assert.ok(!chain.calls.some((c) => c.startsWith('quote')));
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
  const result = await plan({ config: { ...CONFIG, token: { ...CONFIG.token, address: null } }, chain, wallet: WALLET });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'unconfigured');
  assert.deepEqual(result.skip.missing, ['token']);
  assert.equal(chain.calls.length, 0);
});

test('execute sends the buy straight to the burn address and accounts for every wei', async () => {
  const chain = chainWith(ETH / 10n);
  const planned = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;

  const receipt = await execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'mock', token: TOKEN, claimTx: '0xabc' });
  assert.equal(receipt.ethSpent, planned.plan.spend);
  assert.equal(receipt.tokensBurned, chain.burned);
  assert.ok(receipt.tokensBurned >= planned.plan.minOut);
  assert.equal(receipt.balanceBefore - receipt.ethSpent - receipt.gasCost, receipt.balanceAfter);
  assert.equal(receipt.venue, 'pons-curve');
  assert.equal(receipt.claimTx, '0xabc');
  assert.doesNotThrow(() => assertReceiptConserved(receipt));
  assert.ok(chain.calls.some((c) => c === `swap:pons-curve:${planned.plan.spend}:${BURN_ADDRESS}`));
});

test('a buy that falls below minOut reverts and the engine reports it, spending only gas', async () => {
  const chain = chainWith(ETH / 10n, { executionDriftBps: CONFIG.limits.slippageBps + 100 });
  const planned = await plan({ config: CONFIG, chain, ...overrides });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const before = await chain.balance(WALLET);
  await assert.rejects(
    execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'mock', token: TOKEN }),
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
      slippageBps: 300, route: ROUTE, to: WALLET, deadline: 0, quotedAtBlock: 0,
    }),
    /not the burn address/,
  );
});

test('a plan that does not account for the whole balance is refused', () => {
  assert.throws(
    () => assertPlanConserved({
      wallet: WALLET, balance: 10n, gasReserve: 2n, spend: 7n, expectedOut: 100n, minOut: 97n,
      slippageBps: 300, route: ROUTE, to: BURN_ADDRESS, deadline: 0, quotedAtBlock: 0,
    }),
    /leaks/,
  );
});

test('tokensTransferredTo sums only Transfer logs for the token that land on the burn address', () => {
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const amount = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  const OTHER = '0x4444444444444444444444444444444444444444';
  const logs = [
    { address: TOKEN, topics: [topic, pad(CURVE), pad(BURN_ADDRESS)], data: amount(500n) },
    { address: TOKEN, topics: [topic, pad(CURVE), pad(WALLET)], data: amount(999n) },      // not to burn
    { address: OTHER, topics: [topic, pad(WALLET), pad(BURN_ADDRESS)], data: amount(777n) }, // wrong token
    { address: TOKEN, topics: [topic, pad(WALLET), pad(BURN_ADDRESS)], data: amount(25n) },
  ];
  assert.equal(tokensTransferredTo(logs, TOKEN, BURN_ADDRESS), 525n);
});

test('a multi-cycle run of claim → buy → burn never leaks and the site data adds up', async () => {
  const chain = chainWith(0n);
  const receipts = [];
  const claims: ClaimReceipt[] = [];
  for (let i = 1; i <= 8; i++) {
    chain.accrue(ETH / 50n + BigInt(i) * 10n ** 15n);
    const claimed = await claimRewards({ config: CONFIG, chain, ...overrides, mode: 'mock' });
    if (claimed.ok) claims.push(claimed.receipt);
    const planned = await plan({ config: CONFIG, chain, ...overrides });
    if (!planned.ok) continue;
    const r = await execute({ config: CONFIG, chain, plan: planned.plan, id: i, mode: 'mock', token: TOKEN, claimTx: claimed.ok ? claimed.receipt.txHash : null });
    assertReceiptConserved(r);
    receipts.push(r);
  }
  assert.equal(claims.length, 8);
  assert.ok(receipts.length >= 7);

  const data = toSiteData(CONFIG, { receipts, claims }, await chain.tokenTotalSupply());
  assert.equal(BigInt(data.totals.tokensBurnedRaw), chain.burned);
  assert.equal(BigInt(data.totals.ethSpentRaw), receipts.reduce((s, r) => s + r.ethSpent, 0n));
  assert.equal(BigInt(data.totals.claimedRaw), claims.reduce((s, c) => s + c.amount, 0n));
  assert.equal(data.totals.burns, receipts.length);
  assert.equal(data.totals.claims, 8);
  assert.match(data.totals.supplyBurnedPct ?? '', /%$/);
  assert.equal(data.burns[0]?.venue, 'pons-curve');
  assert.match(data.burns[0]?.explorerUrl ?? '', /^https:\/\/robinhoodchain\.blockscout\.com\/tx\/0x/);
});

test('an empty ledger produces an honest empty site file', () => {
  const data = toSiteData(CONFIG, { receipts: [], claims: [] }, null);
  assert.equal(data.mode, 'none');
  assert.equal(data.totals.burns, 0);
  assert.equal(data.totals.tokensBurnedRaw, '0');
  assert.equal(data.totals.lastBurnAt, null);
  assert.deepEqual(data.burns, []);
});
