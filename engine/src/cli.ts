#!/usr/bin/env node
/**
 * faucet — command line for the fee-recycling engine.
 *
 *   faucet policy                       print the routing policy and prove it sums to 100%
 *   faucet cycle [options]              run one or more epochs
 *   faucet verify <file> <owner>        rebuild a published claim file and check a proof
 *   faucet doctor                       check config + RPC reachability
 *
 * Live settlement is intentionally not wired to a signer in this build: `cycle`
 * computes and publishes intents, and signing is a separate, deliberate step.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CONFIG, assertPolicyBalanced, type FaucetConfig } from './config.js';
import { claimPackage } from './distributor.js';
import { runCycle, type CycleResult } from './engine.js';
import { verifyProof } from './merkle.js';
import { formatAmount, renderEpoch, toClaimFile, toSiteData } from './report.js';
import { SolanaRpc } from './rpc.js';
import { MockFeeSource, syntheticReceipts } from './sources/mock.js';
import { VaultFeeSource } from './sources/vault.js';
import type { FeeSource, HolderWeight, SlotWindow } from './types.js';

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint =
  (code: string) =>
  (text: string): string =>
    useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

const dim = paint('2');
const green = paint('32');
const red = paint('31');
const cyan = paint('36');
const bold = paint('1');

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function numberOption(argv: readonly string[], name: string, fallback: number): number {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got "${raw}"`);
  return parsed;
}

function usage(): string {
  return [
    `${bold('faucet')} — every fee drips back into the project`,
    '',
    '  faucet policy                          show the routing policy',
    '  faucet cycle [--epochs N] [--seed N]   run epochs (mock sources unless --live)',
    '           [--live] [--write-site] [--out DIR]',
    '  faucet verify <claims.json> <owner>    verify a published claim proof',
    '  faucet doctor                          sanity-check config and RPC',
    '',
  ].join('\n');
}

async function cmdPolicy(config: FaucetConfig): Promise<void> {
  assertPolicyBalanced(config.routing);
  process.stdout.write(
    `\n  ${bold(`${config.project.name} ($${config.project.ticker})`)} on ${config.project.launchpad}\n`,
  );
  process.stdout.write(`  ${dim(config.project.tagline)}\n\n`);

  for (const rule of config.routing.rules) {
    const pct = `${(rule.bps / 100).toFixed(2)}%`.padStart(7);
    const bar = '#'.repeat(Math.round(rule.bps / 250)).padEnd(40);
    process.stdout.write(`  ${cyan(bar)} ${pct}  ${bold(rule.label)}\n`);
    process.stdout.write(`  ${' '.repeat(40)}          ${dim(rule.intent)}\n\n`);
  }

  process.stdout.write(`  ${green('100.00% of collected fees are routed back into the project.')}\n\n`);
}

function mockSources(config: FaucetConfig, seed: number, window: SlotWindow): FeeSource[] {
  return [
    new MockFeeSource({
      kind: 'pons-creator-fee',
      label: 'Pons creator fees',
      mint: config.native,
      receipts: syntheticReceipts(seed, 24, window),
    }),
    new MockFeeSource({
      kind: 'lp-trading-fee',
      label: 'LP trading fees',
      mint: config.native,
      receipts: syntheticReceipts(seed + 1, 40, window),
    }),
  ];
}

function liveSources(config: FaucetConfig, rpc: SolanaRpc): FeeSource[] {
  const sources: FeeSource[] = [];
  const { ponsCreatorVault, lpFeeVault } = config.feeAccounts;

  if (ponsCreatorVault) {
    sources.push(
      new VaultFeeSource({
        kind: 'pons-creator-fee',
        label: 'Pons creator fees',
        vault: ponsCreatorVault,
        mint: config.native,
        rpc,
      }),
    );
  }
  if (lpFeeVault) {
    sources.push(
      new VaultFeeSource({
        kind: 'lp-trading-fee',
        label: 'LP trading fees',
        vault: lpFeeVault,
        mint: config.native,
        rpc,
      }),
    );
  }

  if (sources.length === 0) {
    throw new Error(
      'No fee accounts configured. Set feeAccounts.ponsCreatorVault / lpFeeVault in engine/src/config.ts before running --live.',
    );
  }
  return sources;
}

/** Deterministic holder set for dry runs, so the mock drip is reproducible. */
function mockHolders(seed: number, count: number): HolderWeight[] {
  let state = (seed * 2_654_435_761) >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffff_ffff;
  };
  return Array.from({ length: count }, (_, i) => ({
    owner: `Hood${i.toString().padStart(3, '0')}${'x'.repeat(28)}`,
    weight: BigInt(Math.floor(next() * 90_000_000) + 1_000_000),
  }));
}

async function cmdCycle(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const epochs = Math.max(1, Math.floor(numberOption(argv, 'epochs', 1)));
  const seed = Math.floor(numberOption(argv, 'seed', 7));
  const live = flag(argv, 'live');
  const outDir = resolve(option(argv, 'out') ?? 'out');

  const rpcUrl = process.env['FAUCET_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
  const rpc = new SolanaRpc({ url: rpcUrl });

  const headSlot = live ? await rpc.getSlot() : 250_000_000;
  const span = config.epoch.slots;

  const results: CycleResult[] = [];
  let carry = 0n;

  for (let i = 0; i < epochs; i++) {
    const window: SlotWindow = {
      fromSlot: headSlot - span * (epochs - i),
      toSlot: headSlot - span * (epochs - i - 1),
    };

    const sources = live ? liveSources(config, rpc) : mockSources(config, seed + i * 17, window);
    const holders = live ? await liveHolders(config, rpc) : mockHolders(seed + i, 120);

    const result = await runCycle({
      config,
      epochId: i + 1,
      window,
      sources,
      holders,
      carryIn: carry,
    });

    carry = result.epoch.carryOut;
    results.push(result);
    process.stdout.write(`\n${renderEpoch(result, config)}\n`);
  }

  const totalRecycled = results.reduce((sum, r) => (r.settled ? sum + r.epoch.collected : sum), 0n);
  process.stdout.write(
    `\n  ${bold(green(`${formatAmount(totalRecycled, config.native)} ${config.native.symbol}`))}` +
      ` recycled across ${results.filter((r) => r.settled).length} settled epoch(s).` +
      (live ? '' : `  ${dim('(mock sources — pass --live for real fee accounts)')}`) +
      '\n\n',
  );

  if (flag(argv, 'write-site')) {
    const siteData = toSiteData(config, results);
    const sitePath = join('site', 'data', 'faucet.json');
    await writeJson(sitePath, JSON.stringify(siteData, null, 2));
    process.stdout.write(`  wrote ${sitePath}\n`);

    // Claim files go to the site too, so the in-browser verifier can rebuild
    // the tree from exactly what the CLI verifies against.
    const index: Array<{ epoch: number; root: string; claims: number; file: string }> = [];
    for (const result of results) {
      if (!result.settled) continue;
      const body = toClaimFile(result.epoch);
      const file = `epoch-${result.epoch.id}.json`;
      await writeJson(join(outDir, 'claims', file), body);
      await writeJson(join('site', 'data', 'claims', file), body);
      index.push({
        epoch: result.epoch.id,
        root: result.epoch.distribution.root,
        claims: result.epoch.distribution.claims.length,
        file: `claims/${file}`,
      });
      process.stdout.write(`  wrote ${join(outDir, 'claims', file)}\n`);
    }
    await writeJson(join('site', 'data', 'claims', 'index.json'), JSON.stringify(index, null, 2));
    process.stdout.write(`  wrote site/data/claims/index.json (${index.length} epochs)\n\n`);
  }
}

async function liveHolders(config: FaucetConfig, rpc: SolanaRpc): Promise<HolderWeight[]> {
  if (!config.mint.address) {
    throw new Error('Set mint.address in engine/src/config.ts before running --live.');
  }
  // getTokenLargestAccounts caps at 20 accounts. This is a floor, not the final
  // design: production runs stream balance changes into a time-weighted index.
  const largest = await rpc.getTokenLargestAccounts(config.mint.address);
  return largest.value.map((entry) => ({ owner: entry.address, weight: BigInt(entry.amount) }));
}

async function cmdVerify(argv: readonly string[]): Promise<void> {
  const file = argv[1];
  const owner = argv[2];
  if (!file || !owner) throw new Error('usage: faucet verify <claims.json> <owner>');

  const parsed = JSON.parse(await readFile(resolve(file), 'utf8')) as {
    root: string;
    claims: Array<{ index: number; owner: string; amountRaw: string }>;
  };

  const claims = parsed.claims.map((c) => ({ index: c.index, owner: c.owner, amount: BigInt(c.amountRaw) }));
  const distribution = {
    root: parsed.root,
    claims,
    total: claims.reduce((sum, c) => sum + c.amount, 0n),
    remainder: 0n,
  };

  const pkg = claimPackage(distribution, owner);
  if (!pkg) {
    process.stdout.write(`\n  ${red(`no claim for ${owner} in ${file}`)}\n\n`);
    process.exitCode = 1;
    return;
  }

  const ok = verifyProof(pkg.claim, pkg.proof, parsed.root);
  process.stdout.write(
    `\n  ${ok ? green('proof valid') : red('proof INVALID')}\n` +
      `  owner  ${pkg.claim.owner}\n` +
      `  index  ${pkg.claim.index}\n` +
      `  amount ${formatAmount(pkg.claim.amount, CONFIG.native)} ${CONFIG.native.symbol}\n` +
      `  proof  ${pkg.proof.length} node(s)\n` +
      `  root   ${parsed.root}\n\n`,
  );
  if (!ok) process.exitCode = 1;
}

async function cmdDoctor(config: FaucetConfig): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];

  try {
    assertPolicyBalanced(config.routing);
    checks.push(['routing policy sums to 100%', true, '']);
  } catch (error) {
    checks.push(['routing policy sums to 100%', false, String(error)]);
  }

  checks.push([
    'mint address configured',
    config.mint.address !== null,
    config.mint.address ? '' : 'set CONFIG.mint.address after launch',
  ]);

  const anyVault = Object.values(config.feeAccounts).some((v) => v !== null);
  checks.push(['at least one fee account configured', anyVault, anyVault ? '' : 'set CONFIG.feeAccounts.*']);

  const rpcUrl = process.env['FAUCET_RPC_URL'];
  if (rpcUrl) {
    try {
      const slot = await new SolanaRpc({ url: rpcUrl, maxRetries: 1 }).getSlot();
      checks.push([`RPC reachable (slot ${slot})`, true, '']);
    } catch (error) {
      checks.push(['RPC reachable', false, String(error)]);
    }
  } else {
    checks.push(['FAUCET_RPC_URL set', false, 'copy .env.example and set FAUCET_RPC_URL']);
  }

  process.stdout.write('\n');
  for (const [label, ok, hint] of checks) {
    process.stdout.write(`  ${ok ? green('ok  ') : red('FAIL')} ${label}${hint ? `  ${dim(hint)}` : ''}\n`);
  }
  process.stdout.write('\n');
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function writeJson(path: string, body: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${body}\n`, 'utf8');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  switch (command) {
    case 'policy':
      return cmdPolicy(CONFIG);
    case 'cycle':
      return cmdCycle(CONFIG, argv);
    case 'verify':
      return cmdVerify(argv);
    case 'doctor':
      return cmdDoctor(CONFIG);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`\n${usage()}\n`);
      return;
    default:
      process.stderr.write(`\nunknown command: ${command}\n\n${usage()}\n`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${red('error')} ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
