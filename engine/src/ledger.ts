/**
 * The burn ledger: every claim and every burn, persisted, and the site's
 * data file built from it. bigints are written as decimal strings; JSON has
 * no integer wide enough for wei and a float would quietly round a balance.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FaucetConfig } from './config.js';
import type { Asset, BurnReceipt, ClaimReceipt, Raw } from './types.js';

export const LEDGER_PATH = 'site/data/burns.json';
export const SITE_DATA_PATH = 'site/data/faucet.json';
/** Mock runs never touch the shipped data. */
export const MOCK_LEDGER_PATH = '.faucet-mock/burns.json';
export const MOCK_SITE_DATA_PATH = '.faucet-mock/faucet.json';

type BigKeys = 'ethSpent' | 'tokensBurned' | 'expectedOut' | 'minOut' | 'gasUsed' | 'gasCost' | 'balanceBefore' | 'balanceAfter';
type StoredReceipt = Omit<BurnReceipt, BigKeys> & Record<BigKeys, string>;
type StoredClaim = Omit<ClaimReceipt, 'amount' | 'gasUsed' | 'gasCost'> & { amount: string; gasUsed: string; gasCost: string };

export interface Ledger {
  receipts: BurnReceipt[];
  claims: ClaimReceipt[];
}

export function emptyLedger(): Ledger {
  return { receipts: [], claims: [] };
}

export async function loadLedger(path = LEDGER_PATH): Promise<Ledger> {
  let raw: { receipts?: StoredReceipt[]; claims?: StoredClaim[] };
  try {
    raw = JSON.parse(await readFile(resolve(path), 'utf8')) as typeof raw;
  } catch {
    return emptyLedger();
  }
  return {
    receipts: (raw.receipts ?? []).map((r) => ({
      ...r,
      venue: r.venue ?? 'pons-curve',
      claimTx: r.claimTx ?? null,
      ethSpent: BigInt(r.ethSpent), tokensBurned: BigInt(r.tokensBurned),
      expectedOut: BigInt(r.expectedOut), minOut: BigInt(r.minOut),
      gasUsed: BigInt(r.gasUsed), gasCost: BigInt(r.gasCost),
      balanceBefore: BigInt(r.balanceBefore), balanceAfter: BigInt(r.balanceAfter),
    })),
    claims: (raw.claims ?? []).map((c) => ({ ...c, amount: BigInt(c.amount), gasUsed: BigInt(c.gasUsed), gasCost: BigInt(c.gasCost) })),
  };
}

export async function saveLedger(ledger: Ledger, path = LEDGER_PATH): Promise<void> {
  const stored = {
    receipts: ledger.receipts.map((r) => ({
      ...r,
      ethSpent: r.ethSpent.toString(), tokensBurned: r.tokensBurned.toString(),
      expectedOut: r.expectedOut.toString(), minOut: r.minOut.toString(),
      gasUsed: r.gasUsed.toString(), gasCost: r.gasCost.toString(),
      balanceBefore: r.balanceBefore.toString(), balanceAfter: r.balanceAfter.toString(),
    })),
    claims: ledger.claims.map((c) => ({ ...c, amount: c.amount.toString(), gasUsed: c.gasUsed.toString(), gasCost: c.gasCost.toString() })),
  };
  await writeJson(path, stored);
}

/** Refuses a receipt whose numbers do not add up, before it can be persisted. */
export function assertReceiptConserved(r: BurnReceipt): void {
  if (r.balanceBefore - r.ethSpent - r.gasCost !== r.balanceAfter) {
    throw new Error(`receipt ${r.id} leaks: ${r.balanceBefore} - ${r.ethSpent} - ${r.gasCost} != ${r.balanceAfter}`);
  }
  if (r.tokensBurned < r.minOut) throw new Error(`receipt ${r.id}: burned ${r.tokensBurned} below minOut ${r.minOut}`);
}

export function formatAmount(raw: Raw, asset: Asset, maxFractionDigits = 4): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(asset.decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const fractionText = fraction.toString().padStart(asset.decimals, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${wholeText}${fractionText ? `.${fractionText}` : ''}`;
}

export interface SiteData {
  generatedAt: string;
  mode: 'live' | 'mock' | 'none';
  project: FaucetConfig['project'];
  chain: { chainId: number; name: string; explorerTx: string };
  token: Asset;
  native: Asset;
  devWallet: string | null;
  burnAddress: string;
  venues: { feeEscrow: string; factory: string; hook: string; universalRouter: string; poolManager: string };
  policy: Array<{ bucket: string; label: string; bps: number; intent: string }>;
  limits: { gasReserve: string; minBuyback: string; minClaim: string; slippageBps: number; deadlineSeconds: number; intervalSeconds: number };
  totals: {
    burns: number;
    claims: number;
    claimedRaw: string; claimed: string;
    ethSpentRaw: string; ethSpent: string;
    tokensBurnedRaw: string; tokensBurned: string;
    gasRaw: string; gas: string;
    supplyRaw: string | null; supplyBurnedPct: string | null;
    lastBurnAt: string | null;
    lastClaimAt: string | null;
  };
  burns: Array<{
    id: number; txHash: string; block: number; timestamp: string; mode: string; venue: string;
    ethSpentRaw: string; ethSpent: string;
    tokensBurnedRaw: string; tokensBurned: string;
    expectedOut: string; minOut: string; slippageRealisedBps: number;
    gas: string; explorerUrl: string; claimTx: string | null; claimUrl: string | null;
  }>;
  claims: Array<{ txHash: string; block: number; timestamp: string; mode: string; amountRaw: string; amount: string; gas: string; explorerUrl: string }>;
}

export function toSiteData(config: FaucetConfig, ledger: Ledger, totalSupply: Raw | null): SiteData {
  const receipts = [...ledger.receipts].sort((a, b) => a.id - b.id);
  const claims = [...ledger.claims].sort((a, b) => a.block - b.block);
  const eth = receipts.reduce((s, r) => s + r.ethSpent, 0n);
  const tokens = receipts.reduce((s, r) => s + r.tokensBurned, 0n);
  const gas = receipts.reduce((s, r) => s + r.gasCost, 0n) + claims.reduce((s, c) => s + c.gasCost, 0n);
  const claimed = claims.reduce((s, c) => s + c.amount, 0n);
  const last = receipts[receipts.length - 1];
  const lastClaim = claims[claims.length - 1];
  const link = (hash: string): string => `${config.chain.explorerTx}${hash}`;

  const pct = totalSupply && totalSupply > 0n
    ? `${(Number((tokens * 1_000_000n) / totalSupply) / 10_000).toFixed(4)}%`
    : null;

  return {
    generatedAt: new Date().toISOString(),
    mode: last ? last.mode : lastClaim ? lastClaim.mode : 'none',
    project: config.project,
    chain: { chainId: config.chain.chainId, name: config.project.chain, explorerTx: config.chain.explorerTx },
    token: config.token,
    native: config.native,
    devWallet: config.devWallet,
    burnAddress: config.burnAddress,
    venues: {
      feeEscrow: config.pons.feeEscrow, factory: config.pons.factory, hook: config.pons.hook,
      universalRouter: config.uniswapV4.universalRouter, poolManager: config.uniswapV4.poolManager,
    },
    policy: config.routing.rules.map((r) => ({ bucket: r.bucket, label: r.label, bps: r.bps, intent: r.intent })),
    limits: {
      gasReserve: formatAmount(config.limits.gasReserveWei, config.native, 6),
      minBuyback: formatAmount(config.limits.minBuybackWei, config.native, 6),
      minClaim: formatAmount(config.limits.minClaimWei, config.native, 6),
      slippageBps: config.limits.slippageBps,
      deadlineSeconds: config.limits.deadlineSeconds,
      intervalSeconds: config.limits.intervalSeconds,
    },
    totals: {
      burns: receipts.length,
      claims: claims.length,
      claimedRaw: claimed.toString(), claimed: formatAmount(claimed, config.native),
      ethSpentRaw: eth.toString(), ethSpent: formatAmount(eth, config.native),
      tokensBurnedRaw: tokens.toString(), tokensBurned: formatAmount(tokens, config.token, 2),
      gasRaw: gas.toString(), gas: formatAmount(gas, config.native, 6),
      supplyRaw: totalSupply === null ? null : totalSupply.toString(),
      supplyBurnedPct: pct,
      lastBurnAt: last ? last.timestamp : null,
      lastClaimAt: lastClaim ? lastClaim.timestamp : null,
    },
    burns: receipts.map((r) => ({
      id: r.id, txHash: r.txHash, block: r.block, timestamp: r.timestamp, mode: r.mode, venue: r.venue,
      ethSpentRaw: r.ethSpent.toString(), ethSpent: formatAmount(r.ethSpent, config.native),
      tokensBurnedRaw: r.tokensBurned.toString(), tokensBurned: formatAmount(r.tokensBurned, config.token, 2),
      expectedOut: formatAmount(r.expectedOut, config.token, 2),
      minOut: formatAmount(r.minOut, config.token, 2),
      slippageRealisedBps: r.expectedOut > 0n ? Number(((r.expectedOut - r.tokensBurned) * 10_000n) / r.expectedOut) : 0,
      gas: formatAmount(r.gasCost, config.native, 6),
      explorerUrl: link(r.txHash),
      claimTx: r.claimTx,
      claimUrl: r.claimTx ? link(r.claimTx) : null,
    })),
    claims: claims.map((c) => ({
      txHash: c.txHash, block: c.block, timestamp: c.timestamp, mode: c.mode,
      amountRaw: c.amount.toString(), amount: formatAmount(c.amount, config.native),
      gas: formatAmount(c.gasCost, config.native, 6), explorerUrl: link(c.txHash),
    })),
  };
}

export async function writeJson(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}
