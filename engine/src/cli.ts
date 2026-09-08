#!/usr/bin/env node
/**
 * faucet — command line for the buyback-and-burn engine.
 *
 *   faucet policy                 print the routing policy and prove it sums to 100%
 *   faucet baseline [--set]       show (or record) the wallet balance the engine never spends
 *   faucet claim [--execute]      claim creator rewards from the Pons fee escrow
 *   faucet plan                   read the dev wallet, quote the buy, print what would be bought
 *   faucet burn [--execute]       run one cycle (claim → buy → burn); without --execute it is a dry run
 *   faucet run                    cycle forever, every 3 minutes
 *   faucet status                 totals from the burn ledger
 *   faucet verify <txhash>        confirm a transaction burned the token
 *   faucet doctor                 check config, RPC, the launch record and simulate a buy
 *   faucet reset --yes            empty the ledger and the site data
 *
 * `--mock` runs against an in-memory chain and writes under .faucet-mock/,
 * never into site/data. `--execute` is the only flag that spends anything,
 * and only with a signer.
 */

import { rm } from 'node:fs/promises';
import { claimRewards, ensureBaseline, execute, plan, readyForLive, routeFor } from './buyback.js';
import { CONFIG, assertPolicyBalanced, missingForLive, type FaucetConfig } from './config.js';
import { EthersChain, MockChain, type Chain } from './evm.js';
import {
  LEDGER_PATH, MOCK_LEDGER_PATH, MOCK_SITE_DATA_PATH, SITE_DATA_PATH,
  assertReceiptConserved, baselineFor, claimedPool, emptyLedger, formatAmount, loadLedger, saveLedger, toSiteData, writeJson,
} from './ledger.js';
import { describeRoute, renderClaim, renderPlan, renderReceipt } from './report.js';
import { run as runLoop } from './runner.js';
import type { Address, BurnReceipt } from './types.js';

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (code: string) => (text: string): string => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const bold = paint('1');
const out = (text: string): void => { process.stdout.write(text); };

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
};

function usage(): string {
  return [
    `${bold('faucet')} — every creator reward buys the coin back and burns it`,
    '',
    '  faucet policy                       show the routing policy',
    '  faucet baseline [--set]             show (or record) the wallet balance that is never spent',
    '  faucet claim [--execute] [--mock]   claim creator rewards from the Pons fee escrow',
    '  faucet plan [--mock]                read the wallet and quote the buyback (no spend)',
    '  faucet burn [--execute] [--mock]    one cycle: claim, buy, burn; --execute sends',
    '              [--rounds N] [--write-site]',
    '  faucet run [--every S] [--mock]     cycle forever (default every 180s)',
    '             [--commit-every M]        commit + push the ledger at most every M minutes',
    '  faucet status                       totals from the burn ledger',
    '  faucet verify <txhash>              confirm a tx burned the token',
    '  faucet doctor                       check config, RPC, launch record; simulate a buy',
    '  faucet reset --yes                  empty the ledger and the site data',
    '',
  ].join('\n');
}

function liveChain(config: FaucetConfig, needSigner: boolean): EthersChain {
  const missing = missingForLive(config);
  if (missing.length > 0) throw new Error(`not configured for live: set ${missing.join(', ')}`);
  const privateKey = process.env['FAUCET_DEV_WALLET_KEY'];
  if (needSigner && !privateKey) throw new Error('set FAUCET_DEV_WALLET_KEY to execute');
  const chain = new EthersChain({
    rpcUrl: config.chain.rpcUrl, chainId: config.chain.chainId, privateKey,
    contracts: {
      factory: config.pons.factory, feeEscrow: config.pons.feeEscrow, hook: config.pons.hook,
      universalRouter: config.uniswapV4.universalRouter, quoter: config.uniswapV4.quoter, stateView: config.uniswapV4.stateView,
    },
  });
  if (chain.signer && chain.signer.toLowerCase() !== config.devWallet!.toLowerCase()) {
    throw new Error(`the key in FAUCET_DEV_WALLET_KEY is for ${chain.signer}, not the configured dev wallet ${config.devWallet}`);
  }
  return chain;
}

function mockChain(seed: number): MockChain {
  return new MockChain({
    wallet: MOCK.wallet,
    token: MOCK.token,
    burnAddress: CONFIG.burnAddress,
    balance: 50_000_000_000_000_000n, // 0.05 ETH already in the wallet: never spent
    tokensPerWei: 42_000n + BigInt(seed % 7) * 500n,
    impactPer1e18: 30_000_000_000_000_000n,
    totalSupply: 1_000_000_000n * 10n ** 18n,
    executionDriftBps: 40,
    gasPrice: 300_000_000n,
  });
}

/** Deterministic creator-reward arrivals for the mock chain. */
function mockReward(seed: number, round: number): bigint {
  let s = ((seed + 1) * 2_654_435_761 + round * 40_503) >>> 0;
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  const r = (s >>> 0) / 0xffff_ffff;
  return BigInt(Math.floor(3e15 + r * 40e15)); // 0.003 – 0.043 ETH
}

async function cmdPolicy(config: FaucetConfig): Promise<void> {
  assertPolicyBalanced(config.routing);
  out(`\n  ${bold(`${config.project.name} ($${config.project.ticker})`)} on ${config.project.chain} via ${config.project.launchpad}\n`);
  out(`  ${dim(config.project.tagline)}\n\n`);
  for (const rule of config.routing.rules) {
    out(`  ${'#'.repeat(40)} ${(rule.bps / 100).toFixed(2).padStart(6)}%  ${bold(rule.label)}\n`);
    out(`  ${' '.repeat(49)}${dim(rule.intent)}\n\n`);
  }
  out(`  source     Pons fee escrow ${config.pons.feeEscrow}\n`);
  out(`  recipient  ${config.burnAddress}\n`);
  out(`  ${green('100.00% of creator rewards are routed to buyback and burn.')}\n\n`);
}

async function cmdClaim(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const mock = flag(argv, 'mock');
  const exec = flag(argv, 'execute');
  const chain: Chain = mock ? mockChain(7) : liveChain(config, exec);
  const wallet = mock ? MOCK.wallet : config.devWallet!;
  if (mock) (chain as MockChain).accrue(mockReward(7, 1));

  const claimable = await chain.claimable(wallet);
  out(`\n  claimable in the Pons fee escrow for ${wallet}: ${bold(`${formatAmount(claimable, config.native, 6)} ${config.native.symbol}`)}\n`);
  if (!exec) { out(`  ${dim('dry run — pass --execute to claim')}\n\n`); return; }

  const ledger = mock ? emptyLedger() : await loadLedger();
  await ensureBaseline(mock ? { config, chain, ledger, ...MOCK } : { config, chain, ledger });
  const result = await claimRewards(mock ? { config, chain, ledger, ...MOCK, mode: 'mock' } : { config, chain, ledger, mode: 'live' });
  out(`\n${renderClaim(result, config)}\n\n`);
  if (result.ok) ledger.claims.push(result.receipt);
  if (!mock) {
    await saveLedger(ledger);
    out(`  wrote ${LEDGER_PATH}\n\n`);
  }
}

async function cmdPlan(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const mock = flag(argv, 'mock');
  const chain: Chain = mock ? mockChain(7) : liveChain(config, false);
  const ledger = mock ? emptyLedger() : await loadLedger();
  if (mock) {
    await ensureBaseline({ config, chain, ledger, ...MOCK });
    (chain as MockChain).accrue(mockReward(7, 1));
    const claimed = await claimRewards({ config, chain, ledger, ...MOCK, mode: 'mock' });
    if (claimed.ok) ledger.claims.push(claimed.receipt);
  }
  const result = await plan(mock ? { config, chain, ledger, ...MOCK } : { config, chain, ledger });
  out(`\n${renderPlan(result, config)}\n\n`);
}

async function cmdBurn(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const mock = flag(argv, 'mock');
  const exec = flag(argv, 'execute');
  const rounds = mock ? Math.max(1, Math.floor(numberOption(argv, 'rounds', 1))) : 1;
  const seed = Math.floor(numberOption(argv, 'seed', 7));
  const ledgerPath = mock ? MOCK_LEDGER_PATH : LEDGER_PATH;
  const sitePath = mock ? MOCK_SITE_DATA_PATH : SITE_DATA_PATH;

  if (!mock && !readyForLive(config)) {
    throw new Error(`not configured for live: set ${missingForLive(config).join(', ')} (or pass --mock)`);
  }

  const chain: Chain = mock ? mockChain(seed) : liveChain(config, exec);
  const ledger = mock ? emptyLedger() : await loadLedger(ledgerPath);
  const receipts: BurnReceipt[] = [];
  const mode = mock ? 'mock' : 'live';
  const base = mock ? { config, chain, ledger, ...MOCK } : { config, chain, ledger };

  const hadBaseline = !!baselineFor(ledger, mock ? MOCK.wallet : config.devWallet!);
  const baseline = await ensureBaseline(base);
  if (baseline && !hadBaseline) {
    out(`\n  baseline: ${formatAmount(baseline.balance, config.native, 6)} ${config.native.symbol} already in the wallet; that amount is never spent\n`);
  }

  for (let round = 1; round <= rounds; round++) {
    if (mock) (chain as MockChain).accrue(mockReward(seed, round));

    let claimTx: string | null = null;
    if (exec) {
      const claimed = await claimRewards({ ...base, mode });
      out(`\n${renderClaim(claimed, config)}\n`);
      if (claimed.ok) { ledger.claims.push(claimed.receipt); claimTx = claimed.receipt.txHash; }
    } else {
      const claimable = await chain.claimable(mock ? MOCK.wallet : config.devWallet!);
      out(`\n  claimable in the fee escrow: ${formatAmount(claimable, config.native, 6)} ${config.native.symbol}  ${dim('(dry run: not claimed; the plan below covers the wallet balance only)')}\n`);
    }

    const result = await plan(base);
    out(`\n${renderPlan(result, config)}\n`);
    if (!result.ok) continue;

    if (!exec) {
      out(`\n  ${dim('dry run — pass --execute to send this buy')}\n`);
      continue;
    }

    const id = ledger.receipts.length + 1;
    const receipt = await execute(
      mock
        ? { config, chain, plan: result.plan, id, mode: 'mock', token: MOCK.token, claimTx }
        : { config, chain, plan: result.plan, id, mode: 'live', claimTx },
    );
    assertReceiptConserved(receipt);
    receipts.push(receipt);
    ledger.receipts.push(receipt);
    out(`\n${renderReceipt(receipt, config)}\n`);
  }

  if (exec || (baseline && !hadBaseline)) {
    await saveLedger(ledger, ledgerPath);
    out(`\n  wrote ${ledgerPath} (${ledger.receipts.length} burns, ${ledger.claims.length} claims)\n`);
  }

  if (flag(argv, 'write-site')) {
    const supply = await chain.tokenTotalSupply(mock ? MOCK.token : config.token.address!);
    await writeJson(sitePath, toSiteData(config, ledger, supply));
    out(`  wrote ${sitePath}\n`);
  }

  const eth = receipts.reduce((s, r) => s + r.ethSpent, 0n);
  const tok = receipts.reduce((s, r) => s + r.tokensBurned, 0n);
  if (receipts.length > 0) {
    out(
      `\n  ${bold(green(`${formatAmount(eth, config.native, 6)} ${config.native.symbol}`))} spent, ` +
        `${bold(green(`${formatAmount(tok, config.token, 2)} ${config.token.symbol}`))} burned across ${receipts.length} cycle(s)` +
        (mock ? `  ${dim('(mock chain)')}` : '') + '\n\n',
    );
  } else {
    out('\n');
  }
}

async function cmdRun(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const mock = flag(argv, 'mock');
  const every = Math.max(15, Math.floor(numberOption(argv, 'every', config.limits.intervalSeconds)));
  const commitEvery = Math.max(0, Math.floor(numberOption(argv, 'commit-every', 0)));
  const seed = Math.floor(numberOption(argv, 'seed', 7));
  const maxTicks = Math.floor(numberOption(argv, 'ticks', 0)); // 0 = forever; tests and demos use it

  if (!mock && !readyForLive(config)) {
    throw new Error(`not configured for live: set ${missingForLive(config).join(', ')} (or pass --mock)`);
  }

  const chain: Chain = mock ? mockChain(seed) : liveChain(config, true);
  out(
    `\n  ${bold('faucet run')}  every ${every}s  ${mock ? dim('(mock chain)') : `wallet ${config.devWallet}`}` +
      (commitEvery ? `  commit every ${commitEvery}m` : '') +
      `\n  ${dim('each cycle: claim from the Pons fee escrow → buy → burn. ctrl-c to stop.')}\n\n`,
  );

  let stopResolve: () => void = () => {};
  const stop = new Promise<void>((resolve) => { stopResolve = resolve; });
  process.once('SIGINT', () => { out('\n  stopping after this tick\n'); stopResolve(); });
  process.once('SIGTERM', () => stopResolve());

  let ticks = 0;
  const result = await runLoop(
    {
      config, chain, intervalSeconds: every, mode: mock ? 'mock' : 'live',
      ...(mock
        ? { overrides: MOCK, paths: { ledger: MOCK_LEDGER_PATH, site: MOCK_SITE_DATA_PATH }, beforeTick: (n: number) => { (chain as MockChain).accrue(mockReward(seed, n)); } }
        : {}),
      commitEveryMinutes: mock ? 0 : commitEvery,
      onTick: () => { ticks += 1; if (maxTicks > 0 && ticks >= maxTicks) stopResolve(); },
    },
    stop,
  );

  out(`\n  ${result.burns} burn(s), ${result.claims} claim(s), ${result.failures} failure(s)\n\n`);
}

async function cmdStatus(config: FaucetConfig): Promise<void> {
  const ledger = await loadLedger();
  const data = toSiteData(config, ledger, null);
  out(`\n  untouched      ${data.funds.untouched ?? 'not recorded yet'}${data.funds.untouched ? ` ${config.native.symbol} (in the wallet before the first claim; never spent)` : ''}\n`);
  out(`  claimed pool   ${data.funds.claimedPool} ${config.native.symbol} (claimed, not yet spent)\n`);
  out(`  claims         ${data.totals.claims}  (${data.totals.claimed} ${config.native.symbol} from the fee escrow)\n`);
  out(`  burns          ${data.totals.burns}\n`);
  out(`  ${config.native.symbol} spent      ${data.totals.ethSpent}\n`);
  out(`  ${config.token.symbol} burned   ${data.totals.tokensBurned}\n`);
  out(`  gas            ${data.totals.gas} ${config.native.symbol}\n`);
  out(`  last burn      ${data.totals.lastBurnAt ?? '—'}\n`);
  out(`  mode           ${data.mode}\n\n`);
}

async function cmdVerify(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const hash = argv[1];
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('usage: faucet verify <txhash>');
  if (!config.token.address) throw new Error('set FAUCET_TOKEN to verify against the token contract');

  const chain = liveChain(config, false);
  const receipt = await chain.receipt(hash, config.token.address, config.burnAddress);
  const ok = receipt.status === 'success' && receipt.tokensToBurn > 0n;

  out(
    `\n  ${ok ? green('burn confirmed') : red('not a burn')}\n` +
      `  tx       ${hash}\n  status   ${receipt.status}\n  block    ${receipt.block}\n` +
      `  burned   ${formatAmount(receipt.tokensToBurn, config.token, 2)} ${config.token.symbol} → ${config.burnAddress}\n\n`,
  );
  if (!ok) process.exitCode = 1;
}

async function cmdBaseline(config: FaucetConfig, argv: readonly string[]): Promise<void> {
  const chain = liveChain(config, false);
  const wallet = config.devWallet!;
  const ledger = await loadLedger();
  const eth = config.native;
  const balance = await chain.balance(wallet);
  const existing = baselineFor(ledger, wallet);
  const pool = claimedPool(ledger);

  if (flag(argv, 'set')) {
    // Re-baseline so the claimed pool stays what the ledger says: anything in
    // the wallet beyond it (a top-up) joins the untouched amount.
    const untouched = balance > pool ? balance - pool : 0n;
    ledger.baseline = { wallet, balance: untouched, block: await chain.blockNumber(), recordedAt: new Date().toISOString() };
    await saveLedger(ledger);
    out(`\n  recorded baseline ${formatAmount(untouched, eth, 6)} ${eth.symbol} for ${wallet} (wallet ${formatAmount(balance, eth, 6)}, claimed pool ${formatAmount(pool, eth, 6)})\n  wrote ${LEDGER_PATH}\n\n`);
    return;
  }

  out(`\n  wallet         ${wallet}\n  balance        ${formatAmount(balance, eth, 6)} ${eth.symbol}\n`);
  if (existing) {
    out(`  untouched      ${formatAmount(existing.balance, eth, 6)} ${eth.symbol}  recorded ${existing.recordedAt} at block ${existing.block}; never spent\n`);
    out(`  claimed pool   ${formatAmount(pool, eth, 6)} ${eth.symbol}  per the ledger; the engine spends only this\n`);
    const above = balance > existing.balance ? balance - existing.balance : 0n;
    if (above > pool) out(`  ${dim(`note: ${formatAmount(above - pool, eth, 6)} ${eth.symbol} above the baseline is not from a claim and will not be spent; \`faucet baseline --set\` folds it into the untouched amount`)}\n`);
  } else {
    out(`  untouched      not recorded yet; the runner records the balance on its first tick, or run \`faucet baseline --set\`\n`);
  }
  out('\n');
}

async function cmdReset(argv: readonly string[]): Promise<void> {
  if (!flag(argv, 'yes')) throw new Error('faucet reset empties site/data; pass --yes to confirm');
  await saveLedger(emptyLedger(), LEDGER_PATH);
  await writeJson(SITE_DATA_PATH, toSiteData(CONFIG, emptyLedger(), null));
  await rm('.faucet-mock', { recursive: true, force: true });
  out(`\n  reset ${LEDGER_PATH} and ${SITE_DATA_PATH}: 0 burns, 0 claims\n\n`);
}

async function cmdDoctor(config: FaucetConfig): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  const check = (label: string, ok: boolean, hint = ''): void => { checks.push([label, ok, hint]); };
  const eth = config.native;

  try { assertPolicyBalanced(config.routing); check('routing policy sums to 100%', true); }
  catch (e) { check('routing policy sums to 100%', false, String(e)); }

  check(`chain ${config.project.chain} (id ${config.chain.chainId}) via ${config.chain.rpcUrl}`, true);
  check('FAUCET_TOKEN set', !!config.token.address, config.token.address ? '' : 'the token contract address');
  check('FAUCET_DEV_WALLET set', !!config.devWallet, config.devWallet ? '' : 'the wallet Pons credits creator rewards to');
  const hasKey = !!process.env['FAUCET_DEV_WALLET_KEY'];
  check(hasKey ? 'FAUCET_DEV_WALLET_KEY set' : 'FAUCET_DEV_WALLET_KEY not set (reads only; needed to claim and buy)', true);

  const probeChain = new EthersChain({
    rpcUrl: config.chain.rpcUrl, chainId: config.chain.chainId,
    contracts: { factory: config.pons.factory, feeEscrow: config.pons.feeEscrow, hook: config.pons.hook, universalRouter: config.uniswapV4.universalRouter, quoter: config.uniswapV4.quoter, stateView: config.uniswapV4.stateView },
  });

  try {
    const id = await probeChain.chainId();
    check(`RPC reachable, chain id ${id}`, id === config.chain.chainId, id === config.chain.chainId ? '' : `expected ${config.chain.chainId}`);
    const gasPrice = await probeChain.gasPrice();
    const buyGas = 160_000n * gasPrice;
    check(`gas price ${formatAmount(gasPrice, { address: null, symbol: 'gwei', decimals: 9 }, 4)} gwei; a buy costs ~${formatAmount(buyGas, eth, 8)} ${eth.symbol}, reserve is ${formatAmount(config.limits.gasReserveWei, eth, 6)}`, buyGas * 3n <= config.limits.gasReserveWei, 'raise FAUCET_GAS_RESERVE_WEI');
  } catch (e) {
    check('RPC reachable', false, e instanceof Error ? e.message : String(e));
  }

  if (config.token.address) {
    const token = config.token.address;
    try {
      const symbol = await probeChain.tokenSymbol(token);
      const supply = await probeChain.tokenTotalSupply(token);
      check(`token ${symbol}, total supply ${formatAmount(supply, config.token, 0)}`, supply > 0n, symbol === config.token.symbol ? '' : `config says ${config.token.symbol}; set FAUCET_TOKEN_SYMBOL`);
    } catch (e) {
      check('token contract responds', false, e instanceof Error ? e.message : String(e));
    }

    try {
      const launch = await probeChain.launch(token);
      check('token is a Pons v2 launch (factory has a record)', launch.exists, launch.exists ? '' : 'not found on the Pons v2 factory; is this a Pons v1 launch or a different chain?');
      if (launch.exists) {
        check(`paired with ${launch.pairToken === '0x0000000000000000000000000000000000000000' ? 'native ETH' : launch.pairToken}`, launch.pairToken === '0x0000000000000000000000000000000000000000', 'the engine buys with ETH only');
        check(`phase: ${launch.graduated ? `graduated, v4 pool liquidity ${launch.poolLiquidity}` : `bonding curve ${launch.curve}`}`, !launch.graduated || launch.poolLiquidity > 0n);
        check(`creator fee recipient ${launch.creatorRecipient}`, !config.devWallet || launch.creatorRecipient.toLowerCase() === config.devWallet.toLowerCase(),
          config.devWallet && launch.creatorRecipient.toLowerCase() !== config.devWallet.toLowerCase() ? `is not FAUCET_DEV_WALLET ${config.devWallet}; rewards accrue to the recipient, so the engine could never claim them` : '');

        const route = routeFor(launch, config.pons.hook);
        if (typeof route === 'string') {
          check(`route: ${route}`, false);
        } else {
          const probeFrom = config.devWallet ?? ('0x1111111111111111111111111111111111111111' as Address);
          const amount = 10n ** 15n;
          const quoted = await probeChain.quote(route, token, amount, probeFrom);
          const simulated = await probeChain.simulateBuy(route, token, amount, probeFrom, config.burnAddress);
          check(`route: ${describeRoute(route)}`, true);
          check(`simulated buy of 0.001 ${eth.symbol} → ${formatAmount(simulated, config.token, 2)} ${config.token.symbol} to ${config.burnAddress} (quote ${formatAmount(quoted, config.token, 2)})`, simulated > 0n && simulated === quoted, simulated === quoted ? '' : 'quote and simulation disagree');
        }
      }
    } catch (e) {
      check('launch record / route', false, e instanceof Error ? e.message : String(e));
    }
  }

  if (config.devWallet) {
    try {
      const bal = await probeChain.balance(config.devWallet);
      check(`dev wallet balance ${formatAmount(bal, eth, 6)} ${eth.symbol}`, true);
      const claimable = await probeChain.claimable(config.devWallet);
      check(`claimable creator rewards in the Pons fee escrow: ${formatAmount(claimable, eth, 6)} ${eth.symbol}`, true);
      const ledger = await loadLedger();
      const baseline = baselineFor(ledger, config.devWallet);
      check(
        baseline
          ? `untouched baseline ${formatAmount(baseline.balance, eth, 6)} ${eth.symbol} recorded; claimed pool ${formatAmount(claimedPool(ledger), eth, 6)} ${eth.symbol} is all the engine may spend`
          : `no baseline yet: the runner records the current balance (${formatAmount(bal, eth, 6)} ${eth.symbol}) on its first tick and never spends it`,
        true,
      );
    } catch (e) {
      check('dev wallet / escrow readable', false, e instanceof Error ? e.message : String(e));
    }
  }

  if (hasKey && config.devWallet) {
    try {
      const signed = liveChain(config, true);
      check(`signer ${signed.signer} matches FAUCET_DEV_WALLET`, true);
    } catch (e) {
      check('signer matches FAUCET_DEV_WALLET', false, e instanceof Error ? e.message : String(e));
    }
  }

  out('\n');
  for (const [label, ok, hint] of checks) out(`  ${ok ? green('ok  ') : red('FAIL')} ${label}${hint && (!ok || hint.startsWith('config says')) ? `  ${dim(hint)}` : ''}\n`);
  out('\n');
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  switch (argv[0]) {
    case 'policy': return cmdPolicy(CONFIG);
    case 'baseline': return cmdBaseline(CONFIG, argv);
    case 'claim': return cmdClaim(CONFIG, argv);
    case 'plan': return cmdPlan(CONFIG, argv);
    case 'burn': return cmdBurn(CONFIG, argv);
    case 'run': return cmdRun(CONFIG, argv);
    case 'status': return cmdStatus(CONFIG);
    case 'verify': return cmdVerify(CONFIG, argv);
    case 'doctor': return cmdDoctor(CONFIG);
    case 'reset': return cmdReset(argv);
    case undefined: case 'help': case '--help': case '-h':
      out(`\n${usage()}\n`); return;
    default:
      process.stderr.write(`\nunknown command: ${argv[0]}\n\n${usage()}\n`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${red('error')} ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});

