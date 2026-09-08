/**
 * The runner: one cycle every N seconds, forever.
 *
 * A cycle is claim → plan → execute. Designed to be boring: a cycle that
 * finds nothing to claim and nothing above the floor does nothing, so a short
 * interval is safe. A lock file stops two runners from overlapping. Errors
 * back off and are logged, never retried blind: a revert waits for the next
 * tick with a fresh quote rather than hammering the market. Optionally, when
 * the ledger has changed and enough time has passed, the runner commits
 * site/data and pushes, which is what makes a Vercel-hosted site redeploy
 * with the new burn.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { claimRewards, execute, plan, type PlanResult } from './buyback.js';
import type { FaucetConfig } from './config.js';
import type { Chain } from './evm.js';
import { LEDGER_PATH, SITE_DATA_PATH, assertReceiptConserved, loadLedger, saveLedger, toSiteData, writeJson } from './ledger.js';
import type { Address, BurnReceipt, ClaimReceipt, SkipReason } from './types.js';

export interface RunnerOptions {
  readonly config: FaucetConfig;
  readonly chain: Chain;
  readonly intervalSeconds: number;
  readonly mode: 'live' | 'mock';
  /** Address overrides for mock mode. */
  readonly overrides?: { wallet: Address; token: Address };
  /** Commit and push site/data when the ledger changed and this many minutes passed. 0 disables. */
  readonly commitEveryMinutes?: number;
  readonly lockPath?: string;
  readonly log?: (line: string) => void;
  /** Called after each tick with the outcome; tests use it to stop the loop. */
  readonly onTick?: (outcome: TickOutcome) => void | Promise<void>;
  /** Mock only: accrue rewards before each tick. */
  readonly beforeTick?: (tick: number) => void | Promise<void>;
  /** Where the ledger and site data are written. Tests point these at temp files. */
  readonly paths?: { readonly ledger: string; readonly site: string };
}

export type TickOutcome =
  | { readonly kind: 'burned'; readonly receipt: BurnReceipt; readonly claim: ClaimReceipt | null }
  | { readonly kind: 'claimed'; readonly claim: ClaimReceipt; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string; readonly backoffSeconds: number; readonly claim: ClaimReceipt | null };

export class RunnerLock {
  readonly #path: string;
  #fd: number | null = null;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  acquire(): void {
    if (existsSync(this.#path)) {
      const pid = readFileSync(this.#path, 'utf8').trim();
      if (pid && isAlive(Number(pid))) {
        throw new Error(`another runner (pid ${pid}) holds ${this.#path}`);
      }
      unlinkSync(this.#path); // stale lock from a crashed runner
    }
    this.#fd = openSync(this.#path, 'wx');
    writeSync(this.#fd, String(process.pid));
  }

  release(): void {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
    if (existsSync(this.#path)) unlinkSync(this.#path);
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function describeSkip(skip: SkipReason): string {
  switch (skip.kind) {
    case 'unconfigured': return `unconfigured: ${skip.missing.join(', ')}`;
    case 'below-floor': return `spendable ${skip.spendable} wei is under the ${skip.floor} wei floor`;
    case 'no-route': return `no route: ${skip.detail}`;
  }
}

/** One cycle. Throws on a failure after something was signed; the runner records it. */
export async function tick(options: RunnerOptions, id: number): Promise<TickOutcome> {
  const { config, chain, mode, overrides } = options;
  const base = overrides ? { config, chain, ...overrides } : { config, chain };

  let claim: ClaimReceipt | null = null;
  try {
    const claimed = await claimRewards({ ...base, mode });
    if (claimed.ok) claim = claimed.receipt;

    const planned: PlanResult = await plan(base);
    if (!planned.ok) {
      const reason = describeSkip(planned.skip);
      return claim ? { kind: 'claimed', claim, reason } : { kind: 'skipped', reason };
    }

    const receipt = await execute(
      overrides
        ? { config, chain, plan: planned.plan, id, mode, token: overrides.token, claimTx: claim?.txHash ?? null }
        : { config, chain, plan: planned.plan, id, mode, claimTx: claim?.txHash ?? null },
    );
    assertReceiptConserved(receipt);
    return { kind: 'burned', receipt, claim };
  } catch (error) {
    throw new TickError(error instanceof Error ? error.message : String(error), claim);
  }
}

/** A failure that may have happened after a claim landed; the claim is still real. */
export class TickError extends Error {
  constructor(message: string, readonly claim: ClaimReceipt | null) {
    super(message);
  }
}

/**
 * Runs until `stop` resolves. Backoff after a failure doubles from the
 * interval up to ten minutes and resets on the next success or skip.
 */
export async function run(options: RunnerOptions, stop: Promise<void>): Promise<{ burns: number; claims: number; failures: number }> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const lock = new RunnerLock(options.lockPath ?? '.faucet.lock');
  lock.acquire();

  let stopped = false;
  void stop.then(() => { stopped = true; });

  const ledgerPath = options.paths?.ledger ?? LEDGER_PATH;
  const sitePath = options.paths?.site ?? SITE_DATA_PATH;
  const ledger = await loadLedger(ledgerPath);
  if (options.mode === 'mock') {
    ledger.receipts = ledger.receipts.filter((r) => r.mode !== 'mock');
    ledger.claims = ledger.claims.filter((r) => r.mode !== 'mock');
  }

  let burns = 0;
  let claims = 0;
  let failures = 0;
  let backoff = 0;
  let lastCommit = Date.now();
  let dirty = false;
  let n = 0;

  const publish = async (): Promise<void> => {
    await saveLedger(ledger, ledgerPath);
    const token = options.overrides?.token ?? options.config.token.address;
    const supply = token ? await options.chain.tokenTotalSupply(token) : null;
    await writeJson(sitePath, toSiteData(options.config, ledger, supply));
    dirty = true;
  };

  const maybeCommit = (): void => {
    const every = options.commitEveryMinutes ?? 0;
    if (every <= 0 || !dirty) return;
    if (Date.now() - lastCommit < every * 60_000) return;
    try {
      execFileSync('git', ['add', ledgerPath, sitePath], { stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', `burn ledger: ${ledger.receipts.length} burns, ${ledger.claims.length} claims`], { stdio: 'ignore' });
      execFileSync('git', ['push', '-q'], { stdio: 'ignore' });
      log(`  committed and pushed the ledger (${ledger.receipts.length} burns)`);
      dirty = false;
      lastCommit = Date.now();
    } catch (error) {
      log(`  ledger commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    while (!stopped) {
      n += 1;
      const started = Date.now();
      let outcome: TickOutcome;

      try {
        if (options.beforeTick) await options.beforeTick(n);
        outcome = await tick(options, ledger.receipts.length + 1);
        backoff = 0;
      } catch (error) {
        failures += 1;
        backoff = Math.min(600, backoff === 0 ? options.intervalSeconds : backoff * 2);
        outcome = {
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error),
          backoffSeconds: backoff,
          claim: error instanceof TickError ? error.claim : null,
        };
      }

      const stamp = new Date().toISOString().slice(11, 19);
      const claimed = outcome.kind === 'skipped' ? null : outcome.claim;
      if (claimed) {
        claims += 1;
        ledger.claims.push(claimed);
        log(`${stamp}  claim  ${claimed.amount} wei from the fee escrow  tx ${claimed.txHash}`);
      }
      if (outcome.kind === 'burned') {
        burns += 1;
        ledger.receipts.push(outcome.receipt);
        log(`${stamp}  burn #${outcome.receipt.id}  ${outcome.receipt.venue}  spent ${outcome.receipt.ethSpent} wei  burned ${outcome.receipt.tokensBurned}  tx ${outcome.receipt.txHash}`);
      } else if (outcome.kind === 'skipped' || outcome.kind === 'claimed') {
        log(`${stamp}  skip   ${outcome.reason}`);
      } else {
        log(`${stamp}  FAIL   ${outcome.error}  (backing off ${outcome.backoffSeconds}s)`);
      }
      if (claimed || outcome.kind === 'burned') await publish();

      maybeCommit();
      if (options.onTick) await options.onTick(outcome);
      if (stopped) break;

      const wait = (outcome.kind === 'failed' ? outcome.backoffSeconds : options.intervalSeconds) * 1000;
      const elapsed = Date.now() - started;
      await sleep(Math.max(0, wait - elapsed), stop);
    }
  } finally {
    lock.release();
  }

  return { burns, claims, failures };
}

function sleep(ms: number, stop: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void stop.then(() => { clearTimeout(timer); resolve(); });
  });
}
