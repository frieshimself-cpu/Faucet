import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureBaseline } from '../src/buyback.js';
import { CONFIG } from '../src/config.js';
import { MockChain } from '../src/evm.js';
import { emptyLedger, type Ledger } from '../src/ledger.js';
import { RunnerLock, run, tick } from '../src/runner.js';
import type { Address } from '../src/types.js';
import { BURN_ADDRESS } from '../src/types.js';

const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const overrides = { wallet: WALLET, token: TOKEN };
const ETH = 10n ** 18n;
const TMP = mkdtempSync(join(tmpdir(), 'faucet-runner-'));
const paths = { ledger: join(TMP, 'burns.json'), site: join(TMP, 'faucet.json') };

function chain(balance = 0n, extra: Partial<ConstructorParameters<typeof MockChain>[0]> = {}) {
  return new MockChain({ wallet: WALLET, token: TOKEN, burnAddress: BURN_ADDRESS, balance, tokensPerWei: 40_000n, impactPer1e18: 10_000_000_000_000_000n, totalSupply: 10n ** 27n, executionDriftBps: 20, ...extra });
}

async function baselined(c: MockChain): Promise<Ledger> {
  const ledger = emptyLedger();
  await ensureBaseline({ config: CONFIG, chain: c, ledger, ...overrides });
  return ledger;
}

test('the first tick records the baseline and sends nothing', async () => {
  const c = chain(ETH);
  c.accrue(ETH / 20n);
  const ledger = emptyLedger();
  const out = await tick({ config: CONFIG, chain: c, ledger, intervalSeconds: 1, mode: 'mock', overrides }, 1);
  assert.equal(out.kind, 'baselined');
  assert.equal(ledger.baseline?.balance, ETH);
  assert.ok(!c.calls.some((x) => x.startsWith('swap') || x.startsWith('claim:')));
});

test('a tick with nothing to claim and nothing in the pool is a skip, not a send', async () => {
  const c = chain(ETH / 1000n);
  const out = await tick({ config: CONFIG, chain: c, ledger: await baselined(c), intervalSeconds: 1, mode: 'mock', overrides }, 1);
  assert.equal(out.kind, 'skipped');
  assert.ok(!c.calls.some((x) => x.startsWith('swap') || x.startsWith('claim:')));
});

test('a tick claims first, then buys with what arrived, and only that', async () => {
  const c = chain(ETH);
  const ledger = await baselined(c);
  c.accrue(ETH / 20n);
  const out = await tick({ config: CONFIG, chain: c, ledger, intervalSeconds: 1, mode: 'mock', overrides }, 1);
  assert.equal(out.kind, 'burned');
  if (out.kind !== 'burned') return;
  assert.ok(out.claim, 'the claim is reported with the burn');
  assert.equal(out.receipt.claimTx, out.claim?.txHash);
  assert.equal(out.receipt.ethSpent, ETH / 20n - out.claim!.gasCost - CONFIG.limits.gasReserveWei);
  assert.ok(out.receipt.balanceAfter >= ETH, 'the ETH that was already there is untouched');
  const claimIndex = c.calls.findIndex((x) => x.startsWith('claim:'));
  const swapIndex = c.calls.findIndex((x) => x.startsWith('swap:'));
  assert.ok(claimIndex !== -1 && swapIndex !== -1 && claimIndex < swapIndex, 'claim happens before the buy');
});

test('a claim that does not reach the floor is recorded as a claim, and the ETH waits for the next tick', async () => {
  const c = chain(0n);
  const ledger = await baselined(c);
  c.accrue(CONFIG.limits.minClaimWei * 2n); // above the claim minimum, under the buy floor
  const out = await tick({ config: CONFIG, chain: c, ledger, intervalSeconds: 1, mode: 'mock', overrides }, 1);
  assert.equal(out.kind, 'claimed');
  assert.ok(!c.calls.some((x) => x.startsWith('swap')));
});

test('the loop baselines, burns when rewards arrive, skips when they do not, persists the ledger, and stops on request', async () => {
  const c = chain(ETH / 4n);
  const seen: string[] = [];
  let stopFn: () => void = () => {};
  const stop = new Promise<void>((r) => { stopFn = r; });
  const lock = `.test-runner-${process.pid}.lock`;

  const result = await run({
    config: CONFIG, chain: c, intervalSeconds: 0, mode: 'mock', overrides, lockPath: lock, paths,
    log: () => {},
    beforeTick: (n) => { if (n % 2 === 0) c.accrue(ETH / 20n); },
    onTick: (o) => { seen.push(o.kind); if (seen.length >= 6) stopFn(); },
  }, stop);

  assert.deepEqual(seen, ['baselined', 'burned', 'skipped', 'burned', 'skipped', 'burned']);
  assert.equal(result.burns, 3);
  assert.equal(result.claims, 3);
  assert.equal(result.failures, 0);
  assert.equal(existsSync(lock), false, 'lock released on exit');
  assert.ok((await c.balance(WALLET)) >= ETH / 4n, 'the original quarter ETH was never spent');

  const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8')) as { receipts: unknown[]; claims: unknown[]; baseline: { balance: string } };
  assert.equal(ledger.receipts.length, 3);
  assert.equal(ledger.claims.length, 3);
  assert.equal(ledger.baseline.balance, (ETH / 4n).toString());
  const site = JSON.parse(readFileSync(paths.site, 'utf8')) as { totals: { burns: number; claims: number }; funds: { untouchedRaw: string } };
  assert.equal(site.totals.burns, 3);
  assert.equal(site.totals.claims, 3);
  assert.equal(site.funds.untouchedRaw, (ETH / 4n).toString());
});

test('a failing tick backs off and the loop continues; a claim that landed before the failure is kept', async () => {
  const c = chain(0n, { executionDriftBps: 900 }); // every fill misses the 3% bound
  const seen: Array<{ kind: string; backoff?: number }> = [];
  let stopFn: () => void = () => {};
  const stop = new Promise<void>((r) => { stopFn = r; });
  const lock = `.test-runner-b-${process.pid}.lock`;
  const tmp = mkdtempSync(join(tmpdir(), 'faucet-runner-b-'));

  const result = await run({
    config: CONFIG, chain: c, intervalSeconds: 0, mode: 'mock', overrides, lockPath: lock, log: () => {},
    paths: { ledger: join(tmp, 'burns.json'), site: join(tmp, 'faucet.json') },
    beforeTick: (n) => { if (n > 1) c.accrue(ETH / 20n); },
    onTick: (o) => { seen.push(o.kind === 'failed' ? { kind: o.kind, backoff: o.backoffSeconds } : { kind: o.kind }); if (seen.length >= 4) stopFn(); },
  }, stop);

  assert.equal(seen[0]?.kind, 'baselined');
  assert.equal(seen.slice(1).every((s) => s.kind === 'failed'), true);
  assert.equal(c.burned, 0n, 'nothing burned when every buy reverts');
  assert.equal(result.claims, 3, 'the claims were real and are recorded');
});

test('a second runner cannot take a live lock; a stale lock is reclaimed', () => {
  const path = `.test-lock-${process.pid}`;
  const a = new RunnerLock(path);
  a.acquire();
  const b = new RunnerLock(path);
  assert.throws(() => b.acquire(), /another runner/);
  a.release();

  writeFileSync(path, '999999999'); // a pid that does not exist
  const c = new RunnerLock(path);
  assert.doesNotThrow(() => c.acquire());
  c.release();
  if (existsSync(path)) unlinkSync(path);
});
