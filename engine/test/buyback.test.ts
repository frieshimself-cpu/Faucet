import assert from 'node:assert/strict';
import test from 'node:test';
import { BuybackError, assertPlanConserved, claimRewards, ensureBaseline, execute, plan, routeFor } from '../src/buyback.js';
import { CONFIG, assertPolicyBalanced, ROUTING } from '../src/config.js';
import { MockChain, tokensTransferredTo } from '../src/evm.js';
import { assertReceiptConserved, claimedPool, emptyLedger, toSiteData, type Ledger } from '../src/ledger.js';
import type { Address, BuybackPlan, Route } from '../src/types.js';
import { BURN_ADDRESS, NATIVE } from '../src/types.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const CURVE = '0x5555555555555555555555555555555555555555' as Address;
const ETH = 10n ** 18n;
const ROUTE: Route = { kind: 'pons-curve', curve: CURVE };
const { gasReserveWei: RESERVE, minBuybackWei: FLOOR, minClaimWei: MIN_CLAIM } = CONFIG.limits;

function chainWith(balance: bigint, extra: Partial<ConstructorParameters<typeof MockChain>[0]> = {}): MockChain {
  return new MockChain({
    wallet: WALLET, token: TOKEN, burnAddress: BURN_ADDRESS, balance,
    tokensPerWei: 40_000n, impactPer1e18: 20_000_000_000_000_000n,
    totalSupply: 1_000_000_000n * ETH, executionDriftBps: 50, ...extra,
  });
}

/** A chain whose wallet already holds `balance`, with that balance recorded as the baseline. */
async function setup(balance: bigint, extra: Partial<ConstructorParameters<typeof MockChain>[0]> = {}) {
  const chain = chainWith(balance, extra);
  const ledger = emptyLedger();
  await ensureBaseline({ config: CONFIG, chain, ledger, wallet: WALLET, token: TOKEN });
  const input = { config: CONFIG, chain, ledger, wallet: WALLET, token: TOKEN };
  /** Accrue a reward in the escrow and claim it into the wallet and the ledger. */
  const earn = async (wei: bigint) => {
    chain.accrue(wei);
    const r = await claimRewards({ ...input, mode: 'mock' as const });
    if (r.ok) ledger.claims.push(r.receipt);
    return r;
  };
  return { chain, ledger, input, earn };
}

const samplePlan = (over: Partial<BuybackPlan>): BuybackPlan => ({
  wallet: WALLET, balance: 100n, untouched: 60n, claimedPool: 40n, gasReserve: 2n, spend: 38n,
  expectedOut: 100n, minOut: 97n, slippageBps: 300, route: ROUTE, to: BURN_ADDRESS, deadline: 0, quotedAtBlock: 0, ...over,
});

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
  assert.ok(MIN_CLAIM > 0n);
  assert.equal(CONFIG.limits.intervalSeconds, 180);
  assert.equal(CONFIG.token.address, '0x6d1b86adfd30d7913d5f0dae6568bd566e6b6327');
});

test('ETH already in the wallet is never spent: without a claim there is nothing to buy with', async () => {
  const { input, chain } = await setup(ETH); // a whole ETH sitting in the wallet
  const result = await plan(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'below-floor');
  assert.equal(result.skip.spendable, 0n);
  assert.ok(!chain.calls.some((c) => c.startsWith('swap') || c.startsWith('quote')));
});

test('after a claim, only the claimed rewards are spent and the original balance stays whole', async () => {
  const { input, chain, earn, ledger } = await setup(ETH);
  const claimed = await earn(ETH / 20n);
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;

  const planned = await plan(input);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const pool = ETH / 20n - claimed.receipt.gasCost;
  assert.equal(planned.plan.untouched, ETH);
  assert.equal(planned.plan.claimedPool, pool);
  assert.equal(claimedPool(ledger), pool);
  assert.equal(planned.plan.spend, pool - RESERVE, 'the whole claimed pool above the reserve');
  assert.ok(planned.plan.spend + RESERVE <= planned.plan.balance - ETH);

  const receipt = await execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'mock', token: TOKEN, claimTx: claimed.receipt.txHash });
  ledger.receipts.push(receipt);
  assert.ok(receipt.balanceAfter >= ETH, 'the original ETH is untouched');
  assert.equal(receipt.balanceAfter, ETH + pool - receipt.ethSpent - receipt.gasCost, 'gas came from the claimed pool too');
  assert.equal(receipt.untouched, ETH);
  assert.equal(claimedPool(ledger), pool - receipt.ethSpent - receipt.gasCost);
});

test('ETH that arrives without a claim (a top-up) is not spent either', async () => {
  const { input, chain } = await setup(ETH / 10n);
  chain.credit(ETH); // someone sends the wallet 1 ETH directly
  const result = await plan(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'below-floor');
  assert.equal(result.skip.spendable, 0n);
});

test('the spend is bounded by the ledger even when the wallet holds more above its baseline', async () => {
  const { input, chain, earn } = await setup(ETH / 10n);
  chain.credit(ETH);                 // a top-up: not a reward
  const claimed = await earn(ETH / 20n); // a reward
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  const planned = await plan(input);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.plan.spend, ETH / 20n - claimed.receipt.gasCost - RESERVE);
});

test('claim: rewards in the escrow are pulled into the wallet, gas and all accounted for', async () => {
  const { chain, earn } = await setup(0n);
  const result = await earn(ETH / 20n);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.amount, ETH / 20n);
  assert.equal(await chain.balance(WALLET), ETH / 20n - result.receipt.gasCost);
  assert.equal(await chain.claimable(WALLET), 0n);
  assert.ok(chain.calls.some((c) => c.startsWith('claim:')));
});

test('claim: nothing claimable, or dust under the minimum, is left alone', async () => {
  const { chain, earn, input } = await setup(0n);
  const empty = await claimRewards({ ...input, mode: 'mock' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.skip, 'nothing-claimable');

  const dust = await earn(MIN_CLAIM - 1n);
  assert.equal(dust.ok, false);
  if (!dust.ok) assert.equal(dust.skip, 'below-minimum');
  assert.ok(!chain.calls.some((c) => c.startsWith('claim:')), 'nothing may be sent');
});

test('a plan without a recorded baseline refuses to spend anything', async () => {
  const chain = chainWith(ETH);
  chain.accrue(ETH / 20n);
  const ledger: Ledger = emptyLedger();
  const claimed = await claimRewards({ config: CONFIG, chain, ledger, wallet: WALLET, token: TOKEN, mode: 'mock' });
  if (claimed.ok) ledger.claims.push(claimed.receipt);
  const result = await plan({ config: CONFIG, chain, ledger, wallet: WALLET, token: TOKEN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'no-baseline');
});

test('the baseline is recorded once and kept; a ledger with history but no baseline is refused', async () => {
  const chain = chainWith(ETH / 4n);
  const ledger = emptyLedger();
  const first = await ensureBaseline({ config: CONFIG, chain, ledger, wallet: WALLET, token: TOKEN });
  assert.equal(first?.balance, ETH / 4n);
  chain.credit(ETH);
  const again = await ensureBaseline({ config: CONFIG, chain, ledger, wallet: WALLET, token: TOKEN });
  assert.equal(again?.balance, ETH / 4n, 'not re-recorded');

  const other = emptyLedger();
  chain.accrue(ETH / 20n);
  const claimed = await claimRewards({ config: CONFIG, chain, ledger: other, wallet: WALLET, token: TOKEN, mode: 'mock' });
  if (claimed.ok) other.claims.push(claimed.receipt);
  await assert.rejects(ensureBaseline({ config: CONFIG, chain, ledger: other, wallet: WALLET, token: TOKEN }), /no baseline/);
});

test('minOut is the quote less the configured slippage', async () => {
  const { input, earn } = await setup(0n);
  await earn(ETH / 10n);
  const result = await plan(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const expected = (result.plan.expectedOut * BigInt(10_000 - CONFIG.limits.slippageBps)) / 10_000n;
  assert.equal(result.plan.minOut, expected);
  assert.equal(result.plan.to, BURN_ADDRESS);
  assert.deepEqual(result.plan.route, ROUTE);
});

test('a graduated launch is routed to its Uniswap v4 pool, with the Pons hook and sorted currencies', async () => {
  const { input, earn } = await setup(0n, { graduated: true });
  await earn(ETH / 10n);
  const result = await plan(input);
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
  const { input, chain, earn } = await setup(0n, { unknownToken: true });
  await earn(ETH / 10n);
  const result = await plan(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'no-route');
  assert.ok(!chain.calls.some((c) => c.startsWith('quote')));
});

test('a claimed pool under the floor is left alone', async () => {
  const { input, chain, earn } = await setup(ETH);
  await earn(RESERVE + FLOOR - 1n);
  const result = await plan(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'below-floor');
  assert.ok(!chain.calls.some((c) => c.startsWith('swap')), 'nothing may be sent');
});

test('an unconfigured engine refuses to plan rather than guessing', async () => {
  const chain = chainWith(ETH);
  const result = await plan({ config: { ...CONFIG, token: { ...CONFIG.token, address: null } }, chain, ledger: emptyLedger(), wallet: WALLET });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip.kind, 'unconfigured');
  assert.deepEqual(result.skip.missing, ['token']);
  assert.equal(chain.calls.length, 0);
});

test('execute sends the buy straight to the burn address and accounts for every wei', async () => {
  const { input, chain, earn } = await setup(ETH / 10n);
  await earn(ETH / 10n);
  const planned = await plan(input);
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

test('a buy that falls below minOut reverts and the engine reports it, spending only gas from the pool', async () => {
  const { input, chain, earn } = await setup(ETH, { executionDriftBps: CONFIG.limits.slippageBps + 100 });
  await earn(ETH / 10n);
  const planned = await plan(input);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const before = await chain.balance(WALLET);
  await assert.rejects(
    execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'mock', token: TOKEN }),
    (e: unknown) => e instanceof BuybackError && /reverted/.test(e.message),
  );
  const after = await chain.balance(WALLET);
  assert.ok(before - after < RESERVE, 'only gas may be lost on a revert');
  assert.ok(after >= ETH, 'and it came from the claimed pool, not the original balance');
  assert.equal(chain.burned, 0n);
});

test('a plan that would touch the baseline is refused', () => {
  assert.throws(() => assertPlanConserved(samplePlan({ spend: 39n })), /touch the baseline/);
});

test('a plan that spends more than was claimed is refused', () => {
  assert.throws(() => assertPlanConserved(samplePlan({ untouched: 0n, claimedPool: 30n, spend: 38n })), /exceeds claimed rewards/);
});

test('a plan whose recipient is not the burn address is refused', () => {
  assert.throws(() => assertPlanConserved(samplePlan({ to: WALLET })), /not the burn address/);
});

test('a receipt that breaches the baseline is refused by the ledger', () => {
  const r = {
    id: 1, txHash: '0x', block: 1, timestamp: '', wallet: WALLET, venue: 'pons-curve' as const, ethSpent: 10n, tokensBurned: 100n,
    expectedOut: 100n, minOut: 90n, gasUsed: 1n, gasCost: 1n, balanceBefore: 20n, balanceAfter: 9n, untouched: 10n, claimTx: null, mode: 'mock' as const,
  };
  assert.throws(() => assertReceiptConserved(r), /untouched baseline/);
  assert.doesNotThrow(() => assertReceiptConserved({ ...r, untouched: 9n }));
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

test('a multi-cycle run of claim → buy → burn never leaks, never touches the baseline, and the site data adds up', async () => {
  const { input, chain, ledger, earn } = await setup(ETH / 2n);
  for (let i = 1; i <= 8; i++) {
    const claimed = await earn(ETH / 50n + BigInt(i) * 10n ** 15n);
    const planned = await plan(input);
    if (!planned.ok) continue;
    const r = await execute({ config: CONFIG, chain, plan: planned.plan, id: i, mode: 'mock', token: TOKEN, claimTx: claimed.ok ? claimed.receipt.txHash : null });
    assertReceiptConserved(r);
    ledger.receipts.push(r);
    assert.ok(r.balanceAfter >= ETH / 2n);
  }
  assert.equal(ledger.claims.length, 8);
  assert.ok(ledger.receipts.length >= 7);
  assert.ok((await chain.balance(WALLET)) >= ETH / 2n, 'the original half ETH is still there');

  const data = toSiteData(CONFIG, ledger, await chain.tokenTotalSupply());
  assert.equal(BigInt(data.totals.tokensBurnedRaw), chain.burned);
  assert.equal(BigInt(data.totals.ethSpentRaw), ledger.receipts.reduce((s, r) => s + r.ethSpent, 0n));
  assert.equal(BigInt(data.totals.claimedRaw), ledger.claims.reduce((s, c) => s + c.amount, 0n));
  assert.equal(data.totals.burns, ledger.receipts.length);
  assert.equal(data.totals.claims, 8);
  assert.equal(data.funds.untouchedRaw, (ETH / 2n).toString());
  assert.equal(BigInt(data.funds.claimedPoolRaw), claimedPool(ledger));
  assert.match(data.totals.supplyBurnedPct ?? '', /%$/);
  assert.equal(data.burns[0]?.venue, 'pons-curve');
  assert.match(data.burns[0]?.explorerUrl ?? '', /^https:\/\/robinhoodchain\.blockscout\.com\/tx\/0x/);
});

test('an empty ledger produces an honest empty site file', () => {
  const data = toSiteData(CONFIG, emptyLedger(), null);
  assert.equal(data.mode, 'none');
  assert.equal(data.totals.burns, 0);
  assert.equal(data.totals.tokensBurnedRaw, '0');
  assert.equal(data.totals.lastBurnAt, null);
  assert.equal(data.funds.untouched, null);
  assert.equal(data.funds.claimedPoolRaw, '0');
  assert.deepEqual(data.burns, []);
});
