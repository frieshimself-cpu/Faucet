/**
 * Serialisation. Two audiences:
 *  - humans reading a terminal (`renderEpoch`)
 *  - the website (`toSiteData`), which is a static page and gets a plain JSON
 *    file rather than an API, so the numbers survive the server being down.
 *
 * bigints are written as decimal strings. JSON has no integer type big enough
 * for lamports, and a float would quietly round a balance.
 */

import type { FaucetConfig } from './config.js';
import type { CycleResult } from './engine.js';
import type { Epoch, Mint, Raw } from './types.js';

export function formatAmount(raw: Raw, mint: Mint, maxFractionDigits = 4): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(mint.decimals);
  const whole = abs / base;
  const fraction = abs % base;

  const fractionText = fraction
    .toString()
    .padStart(mint.decimals, '0')
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '');

  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : '';
  return fractionText ? `${sign}${wholeText}.${fractionText}` : `${sign}${wholeText}`;
}

export function renderEpoch(result: CycleResult, config: FaucetConfig): string {
  const { epoch } = result;
  const mint = config.native;
  const lines: string[] = [];
  const pad = (s: string, n: number): string => s.padEnd(n, ' ');

  lines.push(`  ┌─ epoch ${epoch.id} ─ slots ${epoch.window.fromSlot} → ${epoch.window.toSlot}`);
  lines.push(`  │`);
  lines.push(`  │  collected     ${formatAmount(epoch.collected, mint)} ${mint.symbol}`);
  if (epoch.carryIn > 0n) {
    lines.push(`  │    of which carried in  ${formatAmount(epoch.carryIn, mint)} ${mint.symbol}`);
  }

  for (const collection of epoch.collections) {
    lines.push(
      `  │    ${pad(collection.source, 20)} ${pad(formatAmount(collection.total, mint), 14)} ` +
        `(${collection.receipts.length} receipt${collection.receipts.length === 1 ? '' : 's'})`,
    );
  }

  if (!result.settled) {
    lines.push(`  │`);
    lines.push(`  │  NOT SETTLED  ${result.skipReason ?? 'unknown reason'}`);
    lines.push(`  └─`);
    return lines.join('\n');
  }

  lines.push(`  │`);
  lines.push(`  │  routing`);
  for (const allocation of epoch.allocations) {
    const rule = config.routing.rules.find((r) => r.bucket === allocation.bucket);
    lines.push(
      `  │    ${pad(rule?.label ?? allocation.bucket, 22)} ` +
        `${pad(`${(allocation.bps / 100).toFixed(2)}%`, 8)} ` +
        `${formatAmount(allocation.amount, mint)} ${mint.symbol}`,
    );
  }

  lines.push(`  │`);
  lines.push(`  │  drip`);
  lines.push(`  │    recipients  ${epoch.distribution.claims.length}`);
  lines.push(`  │    distributed ${formatAmount(epoch.distribution.total, mint)} ${mint.symbol}`);
  lines.push(`  │    carry-out   ${formatAmount(epoch.carryOut, mint)} ${mint.symbol}`);
  lines.push(`  │    merkle root ${epoch.distribution.root}`);
  lines.push(`  │`);
  lines.push(`  │  settlement`);
  for (const intent of result.intents) {
    lines.push(
      `  │    ${pad(intent.action, 20)} ${formatAmount(intent.amount, mint)} ${mint.symbol}` +
        (intent.destination ? ` → ${intent.destination}` : ''),
    );
  }
  lines.push(`  └─`);

  return lines.join('\n');
}

export interface SiteEpoch {
  id: number;
  window: { fromSlot: number; toSlot: number };
  closedAt: string;
  settled: boolean;
  collectedRaw: string;
  collected: string;
  allocations: Array<{ bucket: string; label: string; bps: number; amountRaw: string; amount: string }>;
  drip: { recipients: number; totalRaw: string; total: string; root: string };
  sources: Array<{ kind: string; totalRaw: string; total: string; receipts: number }>;
}

export interface SiteData {
  generatedAt: string;
  project: FaucetConfig['project'];
  mint: Mint;
  native: Mint;
  policy: Array<{ bucket: string; label: string; bps: number; intent: string }>;
  totals: {
    epochs: number;
    recycledRaw: string;
    recycled: string;
    drippedRaw: string;
    dripped: string;
    burnedRaw: string;
    burned: string;
    recipients: number;
  };
  epochs: SiteEpoch[];
}

export function toSiteData(config: FaucetConfig, results: readonly CycleResult[]): SiteData {
  const mint = config.native;

  const epochs: SiteEpoch[] = results.map((result) => {
    const epoch: Epoch = result.epoch;
    return {
      id: epoch.id,
      window: { fromSlot: epoch.window.fromSlot, toSlot: epoch.window.toSlot },
      closedAt: epoch.closedAt,
      settled: result.settled,
      collectedRaw: epoch.collected.toString(),
      collected: formatAmount(epoch.collected, mint),
      allocations: epoch.allocations.map((a) => ({
        bucket: a.bucket,
        label: config.routing.rules.find((r) => r.bucket === a.bucket)?.label ?? a.bucket,
        bps: a.bps,
        amountRaw: a.amount.toString(),
        amount: formatAmount(a.amount, mint),
      })),
      drip: {
        recipients: epoch.distribution.claims.length,
        totalRaw: epoch.distribution.total.toString(),
        total: formatAmount(epoch.distribution.total, mint),
        root: epoch.distribution.root,
      },
      sources: epoch.collections.map((c) => ({
        kind: c.source,
        totalRaw: c.total.toString(),
        total: formatAmount(c.total, mint),
        receipts: c.receipts.length,
      })),
    };
  });

  const settled = results.filter((r) => r.settled);
  const recycled = settled.reduce((sum, r) => sum + r.epoch.collected, 0n);
  const dripped = settled.reduce((sum, r) => sum + r.epoch.distribution.total, 0n);
  const burned = settled.reduce(
    (sum, r) => sum + (r.epoch.allocations.find((a) => a.bucket === 'buyback')?.amount ?? 0n),
    0n,
  );
  const recipients = new Set(settled.flatMap((r) => r.epoch.distribution.claims.map((c) => c.owner)));

  return {
    generatedAt: new Date().toISOString(),
    project: config.project,
    mint: config.mint,
    native: config.native,
    policy: config.routing.rules.map((r) => ({
      bucket: r.bucket,
      label: r.label,
      bps: r.bps,
      intent: r.intent,
    })),
    totals: {
      epochs: settled.length,
      recycledRaw: recycled.toString(),
      recycled: formatAmount(recycled, mint),
      drippedRaw: dripped.toString(),
      dripped: formatAmount(dripped, mint),
      burnedRaw: burned.toString(),
      burned: formatAmount(burned, mint),
      recipients: recipients.size,
    },
    epochs,
  };
}

/** Claim files are published per epoch so anyone can rebuild the root themselves. */
export function toClaimFile(epoch: Epoch): string {
  return JSON.stringify(
    {
      epoch: epoch.id,
      root: epoch.distribution.root,
      totalRaw: epoch.distribution.total.toString(),
      claims: epoch.distribution.claims.map((c) => ({
        index: c.index,
        owner: c.owner,
        amountRaw: c.amount.toString(),
      })),
    },
    null,
    2,
  );
}
