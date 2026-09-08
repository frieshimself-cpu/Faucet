/** Terminal rendering of plans and receipts. */

import type { FaucetConfig } from './config.js';
import { formatAmount } from './ledger.js';
import type { ClaimResult, PlanResult } from './buyback.js';
import { poolId } from './pons.js';
import type { BurnReceipt, ClaimReceipt, Route } from './types.js';

export function describeRoute(route: Route): string {
  return route.kind === 'pons-curve'
    ? `Pons bonding curve ${route.curve}`
    : `Uniswap v4 pool ${poolId(route.poolKey).slice(0, 18)}… (tick spacing ${route.poolKey.tickSpacing}, Pons hook)`;
}

export function renderClaim(result: ClaimResult, config: FaucetConfig): string {
  const eth = config.native;
  if (!result.ok) {
    const why = {
      unconfigured: 'NOT READY  no dev wallet configured',
      'nothing-claimable': 'nothing to claim in the fee escrow',
      'below-minimum': `claimable ${formatAmount(result.claimable, eth, 6)} ${eth.symbol} is under the ${formatAmount(config.limits.minClaimWei, eth, 6)} ${eth.symbol} minimum; left in the escrow`,
    }[result.skip];
    return `  ┌─ claim\n  │  ${why}\n  └─`;
  }
  return renderClaimReceipt(result.receipt, config);
}

export function renderClaimReceipt(c: ClaimReceipt, config: FaucetConfig): string {
  const eth = config.native;
  return [
    `  ┌─ claim  ${c.mode === 'mock' ? '(mock chain)' : ''}`,
    `  │  tx            ${c.txHash}`,
    `  │  block         ${c.block}  ${c.timestamp}`,
    `  │  received      ${formatAmount(c.amount, eth, 6)} ${eth.symbol} from the Pons fee escrow`,
    `  │  gas           ${formatAmount(c.gasCost, eth, 8)} ${eth.symbol}`,
    '  └─',
  ].join('\n');
}

export function renderPlan(result: PlanResult, config: FaucetConfig): string {
  const eth = config.native;
  const tok = config.token;
  const lines: string[] = [];

  if (!result.ok) {
    lines.push('  ┌─ plan');
    if (result.skip.kind === 'unconfigured') {
      lines.push(`  │  NOT READY  missing: ${result.skip.missing.join(', ')}`);
    } else if (result.skip.kind === 'no-baseline') {
      lines.push('  │  NO BASELINE  the engine has not recorded the wallet\'s untouched balance yet (the runner does this on its first tick)');
    } else if (result.skip.kind === 'no-route') {
      lines.push(`  │  wallet balance ${formatAmount(result.balance, eth, 6)} ${eth.symbol}`);
      lines.push(`  │  NO ROUTE  ${result.skip.detail}`);
    } else {
      lines.push(`  │  wallet balance ${formatAmount(result.balance, eth, 6)} ${eth.symbol}`);
      lines.push(
        `  │  NOT SETTLED  spendable claimed rewards ${formatAmount(result.skip.spendable, eth, 6)} ${eth.symbol} are under the ` +
          `${formatAmount(result.skip.floor, eth, 6)} ${eth.symbol} floor; nothing bought this cycle`,
      );
    }
    lines.push('  └─');
    return lines.join('\n');
  }

  const p = result.plan;
  lines.push(`  ┌─ plan  (quoted at block ${p.quotedAtBlock})`);
  lines.push('  │');
  lines.push(`  │  wallet        ${p.wallet}`);
  lines.push(`  │  balance       ${formatAmount(p.balance, eth, 6)} ${eth.symbol}`);
  lines.push(`  │  untouched     ${formatAmount(p.untouched, eth, 6)} ${eth.symbol}  (was in the wallet before the first claim; never spent)`);
  lines.push(`  │  claimed pool  ${formatAmount(p.claimedPool, eth, 6)} ${eth.symbol}  (rewards claimed, net of what was spent)`);
  lines.push(`  │  gas reserve   ${formatAmount(p.gasReserve, eth, 6)} ${eth.symbol}  (kept, from the pool)`);
  lines.push(`  │  spend         ${formatAmount(p.spend, eth, 6)} ${eth.symbol}  (100.00% of the rest → buyback)`);
  lines.push('  │');
  lines.push(`  │  venue         ${describeRoute(p.route)}`);
  lines.push(`  │  quote         ${formatAmount(p.expectedOut, tok, 2)} ${tok.symbol}`);
  lines.push(`  │  min out       ${formatAmount(p.minOut, tok, 2)} ${tok.symbol}  (${(p.slippageBps / 100).toFixed(2)}% slippage)`);
  lines.push(`  │  recipient     ${p.to}  (burn)`);
  lines.push(`  │  deadline      ${new Date(p.deadline * 1000).toISOString()}`);
  lines.push('  └─');
  return lines.join('\n');
}

export function renderReceipt(r: BurnReceipt, config: FaucetConfig): string {
  const eth = config.native;
  const tok = config.token;
  const realised = r.expectedOut > 0n ? Number(((r.expectedOut - r.tokensBurned) * 10_000n) / r.expectedOut) : 0;
  return [
    `  ┌─ burn #${r.id}  ${r.mode === 'mock' ? '(mock chain)' : ''}`,
    '  │',
    `  │  tx            ${r.txHash}`,
    `  │  block         ${r.block}  ${r.timestamp}`,
    `  │  venue         ${r.venue}`,
    `  │  spent         ${formatAmount(r.ethSpent, eth, 6)} ${eth.symbol}`,
    `  │  burned        ${formatAmount(r.tokensBurned, tok, 2)} ${tok.symbol}  (quote ${formatAmount(r.expectedOut, tok, 2)}, realised slippage ${(realised / 100).toFixed(2)}%)`,
    `  │  gas           ${formatAmount(r.gasCost, eth, 8)} ${eth.symbol}`,
    `  │  wallet        ${formatAmount(r.balanceBefore, eth, 6)} → ${formatAmount(r.balanceAfter, eth, 6)} ${eth.symbol}`,
    `  │  untouched     ${formatAmount(r.untouched, eth, 6)} ${eth.symbol}  (${r.balanceAfter >= r.untouched ? 'intact' : 'BREACHED'})`,
    `  │  conserved     ${r.balanceBefore - r.ethSpent - r.gasCost === r.balanceAfter ? 'yes' : 'NO'}`,
    ...(r.claimTx ? [`  │  fed by claim  ${r.claimTx}`] : []),
    '  └─',
  ].join('\n');
}
