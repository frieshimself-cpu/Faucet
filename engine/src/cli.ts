#!/usr/bin/env node
/**
 * faucet — command line for the buyback-and-burn engine.
 *
 *   faucet policy                 print the routing policy and prove it sums to 100%
 *   faucet plan                   read the dev wallet, quote the swap, print what would be bought
 *   faucet burn [--execute]       run a cycle; without --execute it is a dry run
 *   faucet status                 totals from the burn ledger
 *   faucet verify <txhash>        confirm a transaction burned the token
 *   faucet doctor                 check config, RPC and signer
 *
 * `--mock` runs against an in-memory chain (pre-launch demo and tests).
 * `--execute` is the only flag that spends anything, and only with a signer.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execute, plan, readyForLive } from './buyback.js';
import { CONFIG, assertPolicyBalanced, missingForLive, type FaucetConfig } from './config.js';
import { EthersChain, MockChain, tokensTransferredTo, type Chain } from './evm.js';
import { LEDGER_PATH, SITE_DATA_PATH, assertReceiptConserved, formatAmount, loadLedger, saveLedger, toSiteData, writeJson } from './ledger.js';
import { renderPlan, renderReceipt } from './report.js';
import type { Address, BurnReceipt } from './types.js';

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (code: string) => (text: string): string => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const bold = paint('1');

const flag = (argv: readonly string[], name: string): boolean => argv.includes(`--${name}`);
const option = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const numberOption = (argv: readonly string[], name: string, fallback: number): number => {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got "${raw}"`);
  return n;
};

/* Fixed addresses for the mock chain, so mock receipts are reproducible. */
const MOCK = {
  wallet: '0x1111111111111111111111111111111111111111' as Address,
  token: '0x2222222222222222222222222222222222222222' as Address,
  router: '0x3333333333333333333333333333333333333333' as Address,
  weth: '0x4444444444444444444444444444444444444444' as Address,
};

function usage(): string {
  return [
    `${bold('faucet')} — every creator reward buys the coin back and burns it`,
    '',
    '  faucet policy                       show the routing policy',
    '  faucet plan [--mock]                read the wallet and quote the buyback (no spend)',
    '  faucet burn [--execute] [--mock]    run a cycle; --execute sends the swap',
    '              [--rounds N] [--write-site]',
    '  faucet status                       totals from the burn ledger',
    '  faucet verify <txhash>              confirm a tx burned the token',
    '  faucet doctor                       check config, RPC and signer',
    '',
  ].join('\n');
}

async function liveChain(config: FaucetConfig, needSigner: boolean): Promise<EthersChain> {
  const missing = missingForLive(config);
  if (missing.length > 0) throw new Error(`not configured for live: set ${missing.join(', ')}`);
  const privateKey = process.env['FAUCET_DEV_WALLET_KEY'];
  if (needSigner && !privateKey) throw new Error('set FAUCET_DEV_WALLET_KEY to execute a buyback');
  const chain = new EthersChain({ rpcUrl: config.chain.rpcUrl!, chainId: config.chain.chainId!, privateKey });
  if (needSigner && chain.signer && chain.signer.toLowerCase() !== config.devWallet!.toLowerCase()) {
    throw new Error(`signer ${chain.signer} is not the configured dev wallet ${config.devWallet}`);
  }
  return chain;
}

function mockChain(seed: number): MockChain {
  return new MockChain({
    wallet: MOCK.wallet,
    token: MOCK.token,
    burnAddress: CONFIG.burnAddress,
    balance: 0n,
    tokensPerWei: 42_000n + BigInt(seed % 7) * 500n,
    impactPer1e18: 30_000_000_000_000_000n,
    totalSupply: 1_000_000_000n * 10n ** 18n,
    executionDriftBps: 40,
  });
}

/** Deterministic creator-reward arrivals for the mock chain. */
function mockReward(seed: number, round: number): bigint {
  let s = ((seed + 1) * 2_654_435_761 + round * 40_503) >>> 0;
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  const r = (s >>> 0) / 0xffff_ffff;
  return BigInt(Math.floor(8e15 + r * 60e15)); // 0.008 – 0.068 ETH
}

async function cmdPolicy(config: FaucetConfig): Promise<void> {
  assertPolicyBalanced(config.routing);
  process.stdout.write(`\n  ${bold(`${config.project.name} ($${config.project.ticker})`)} on ${config.project.chain} via ${config.project.launchpad}\n`);
  process.stdout.write(`  ${dim(config.project.tagline)}\n\n`);
  for (const rule of config.routing.rules) {
    process.stdout.write(`  ${'#'.repeat(40)} ${(rule.bps / 100).toFixed(2).padStart(6)}%  ${bold(rule.label)}\n`);
    process.stdout.write(`  ${' '.repeat(49)}${dim(rule.intent)}\n\n`);
  }
  process.stdout.write(`  recipient  ${config.burnAddress}\n`);
  process.stdout.write(`  ${green('100.00% of creator rewards are routed to buyback and burn.')}\n\n`);
}

async function cmdPlan(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const mock = flag(argv, 'mock');
  const chain: Chain = mock ? mockChain(7) : await liveChain(config, false);
  if (mock) (chain as MockChain).credit(mockReward(7, 1));
  const result = await plan(mock ? { config, chain, ...MOCK } : { config, chain });
  process.stdout.write(`\n${renderPlan(result, config)}\n\n`);
}

async function cmdBurn(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const mock = flag(argv, 'mock');
  const exec = flag(argv, 'execute');
  const rounds = mock ? Math.max(1, Math.floor(numberOption(argv, 'rounds', 1))) : 1;
  const seed = Math.floor(numberOption(argv, 'seed', 7));

  if (!mock && !readyForLive(config)) {
    throw new Error(`not configured for live: set ${missingForLive(config).join(', ')} (or pass --mock)`);
  }

  const chain: Chain = mock ? mockChain(seed) : await liveChain(config, exec);
  const ledger = await loadLedger();
  if (mock) ledger.receipts = ledger.receipts.filter((r) => r.mode !== 'mock');
  const receipts: BurnReceipt[] = [];

  for (let round = 1; round <= rounds; round++) {
    if (mock) (chain as MockChain).credit(mockReward(seed, round));

    const result = await plan(mock ? { config, chain, ...MOCK } : { config, chain });
    process.stdout.write(`\n${renderPlan(result, config)}\n`);
    if (!result.ok) continue;

    if (!exec) {
      process.stdout.write(`\n  ${dim('dry run — pass --execute to send this swap')}\n`);
      continue;
    }

    const id = ledger.receipts.length + receipts.length + 1;
    const receipt = await execute(
      mock
        ? { config, chain, plan: result.plan, id, mode: 'mock', router: MOCK.router, token: MOCK.token }
        : { config, chain, plan: result.plan, id, mode: 'live' },
    );
    assertReceiptConserved(receipt);
    receipts.push(receipt);
    process.stdout.write(`\n${renderReceipt(receipt, config)}\n`);
  }

  if (receipts.length > 0) {
    ledger.receipts.push(...receipts);
    await saveLedger(ledger);
    process.stdout.write(`\n  wrote ${LEDGER_PATH} (${ledger.receipts.length} receipts)\n`);
  }

  if (flag(argv, 'write-site')) {
    const supply = mock
      ? await chain.tokenTotalSupply(MOCK.token)
      : config.token.address ? await chain.tokenTotalSupply(config.token.address) : null;
    await writeJson(SITE_DATA_PATH, toSiteData(config, ledger, supply));
    process.stdout.write(`  wrote ${SITE_DATA_PATH}\n`);
  }

  const eth = receipts.reduce((s, r) => s + r.ethSpent, 0n);
  const tok = receipts.reduce((s, r) => s + r.tokensBurned, 0n);
  if (receipts.length > 0) {
    process.stdout.write(
      `\n  ${bold(green(`${formatAmount(eth, config.native, 6)} ${config.native.symbol}`))} spent, ` +
        `${bold(green(`${formatAmount(tok, config.token, 2)} ${config.token.symbol}`))} burned across ${receipts.length} cycle(s)` +
        (mock ? `  ${dim('(mock chain)')}` : '') + '\n\n',
    );
  } else {
    process.stdout.write('\n');
  }
}

async function cmdStatus(config: FaucetConfig): Promise<void> {
  const ledger = await loadLedger();
  const data = toSiteData(config, ledger, null);
  process.stdout.write(`\n  burns          ${data.totals.burns}\n`);
  process.stdout.write(`  ${config.native.symbol} spent      ${data.totals.ethSpent}\n`);
  process.stdout.write(`  ${config.token.symbol} burned   ${data.totals.tokensBurned}\n`);
  process.stdout.write(`  gas            ${data.totals.gas} ${config.native.symbol}\n`);
  process.stdout.write(`  last burn      ${data.totals.lastBurnAt ?? '—'}\n`);
  process.stdout.write(`  mode           ${data.mode}\n\n`);
}

async function cmdVerify(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const hash = argv[1];
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('usage: faucet verify <txhash>');
  if (!config.token.address) throw new Error('set FAUCET_TOKEN to verify against the token contract');

  const chain = await liveChain(config, false);
  const receipt = await chain.receipt(hash, config.token.address, config.burnAddress);
  const ok = receipt.status === 'success' && receipt.tokensToBurn > 0n;

  process.stdout.write(
    `\n  ${ok ? green('burn confirmed') : red('not a burn')}\n` +
      `  tx       ${hash}\n  status   ${receipt.status}\n  block    ${receipt.block}\n` +
      `  burned   ${formatAmount(receipt.tokensToBurn, config.token, 2)} ${config.token.symbol} → ${config.burnAddress}\n\n`,
  );
  if (!ok) process.exitCode = 1;
}

async function cmdDoctor(config: FaucetConfig): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  try { assertPolicyBalanced(config.routing); checks.push(['routing policy sums to 100%', true, '']); }
  catch (e) { checks.push(['routing policy sums to 100%', false, String(e)]); }

  for (const [name, set] of [
    ['FAUCET_RPC_URL', !!config.chain.rpcUrl], ['FAUCET_CHAIN_ID', config.chain.chainId !== null],
    ['FAUCET_TOKEN', !!config.token.address], ['FAUCET_DEV_WALLET', !!config.devWallet],
    ['FAUCET_ROUTER', !!config.dex.router], ['FAUCET_WETH', !!config.dex.weth],
  ] as const) checks.push([`${name} set`, set, set ? '' : 'see .env.example']);

  checks.push(['FAUCET_DEV_WALLET_KEY set (needed only to execute)', !!process.env['FAUCET_DEV_WALLET_KEY'], '']);

  if (readyForLive(config)) {
    try {
      const chain = await liveChain(config, false);
      const id = await chain.chainId();
      checks.push([`RPC reachable, chain id ${id}`, id === config.chain.chainId, id === config.chain.chainId ? '' : `expected ${config.chain.chainId}`]);
      const bal = await chain.balance(config.devWallet!);
      checks.push([`dev wallet balance ${formatAmount(bal, config.native, 6)} ${config.native.symbol}`, true, '']);
      const supply = await chain.tokenTotalSupply(config.token.address!);
      checks.push([`token total supply ${formatAmount(supply, config.token, 0)} ${config.token.symbol}`, supply > 0n, '']);
      const quote = await chain.quote(config.dex.router!, 10n ** 15n, [config.dex.weth!, config.token.address!]);
      checks.push([`router quotes 0.001 ${config.native.symbol} → ${formatAmount(quote, config.token, 2)} ${config.token.symbol}`, quote > 0n, '']);
    } catch (e) {
      checks.push(['RPC / contracts reachable', false, e instanceof Error ? e.message : String(e)]);
    }
  }

  process.stdout.write('\n');
  for (const [label, ok, hint] of checks) {
    process.stdout.write(`  ${ok ? green('ok  ') : red('FAIL')} ${label}${hint ? `  ${dim(hint)}` : ''}\n`);
  }
  process.stdout.write('\n');
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  switch (argv[0]) {
    case 'policy': return cmdPolicy(CONFIG);
    case 'plan': return cmdPlan(CONFIG, argv);
    case 'burn': return cmdBurn(CONFIG, argv);
    case 'status': return cmdStatus(CONFIG);
    case 'verify': return cmdVerify(CONFIG, argv);
    case 'doctor': return cmdDoctor(CONFIG);
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(`\n${usage()}\n`); return;
    default:
      process.stderr.write(`\nunknown command: ${argv[0]}\n\n${usage()}\n`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${red('error')} ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});

// Keep the import used for the mock verify path in tests.
void tokensTransferredTo;
void readFile;
void resolve;
