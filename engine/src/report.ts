/** Terminal rendering of plans and receipts. */

import type { FaucetConfig } from './config.js';
import { formatAmount } from './ledger.js';
import type { PlanResult } from './buyback.js';
import type { BurnReceipt } from './types.js';

export function renderPlan(result: PlanResult, config: FaucetConfig): string {
  const eth = config.native;
  const tok = config.token;
  const lines: string[] = [];

  if (!result.ok) {
    lines.push('  ┌─ plan');
    if (result.skip.kind === 'unconfigured') {
      lines.push(`  │  NOT READY  missing: ${result.skip.missing.join(', ')}`);
    } else {
      lines.push(`  │  wallet balance ${formatAmount(result.balance, eth, 6)} ${eth.symbol}`);
      lines.push(
        `  │  NOT SETTLED  spendable ${formatAmount(result.skip.spendable, eth, 6)} ${eth.symbol} is under the ` +
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
  lines.push(`  │  gas reserve   ${formatAmount(p.gasReserve, eth, 6)} ${eth.symbol}  (kept)`);
  lines.push(`  │  spend         ${formatAmount(p.spend, eth, 6)} ${eth.symbol}  (100.00% → buyback)`);
  lines.push('  │');
  lines.push(`  │  quote         ${formatAmount(p.expectedOut, tok, 2)} ${tok.symbol}`);
  lines.push(`  │  min out       ${formatAmount(p.minOut, tok, 2)} ${tok.symbol}  (${(p.slippageBps / 100).toFixed(2)}% slippage)`);
  lines.push(`  │  path          ${p.path.join(' → ')}`);
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
    `  │  spent         ${formatAmount(r.ethSpent, eth, 6)} ${eth.symbol}`,
    `  │  burned        ${formatAmount(r.tokensBurned, tok, 2)} ${tok.symbol}  (quote ${formatAmount(r.expectedOut, tok, 2)}, realised slippage ${(realised / 100).toFixed(2)}%)`,
    `  │  gas           ${formatAmount(r.gasCost, eth, 8)} ${eth.symbol}`,
    `  │  wallet        ${formatAmount(r.balanceBefore, eth, 6)} → ${formatAmount(r.balanceAfter, eth, 6)} ${eth.symbol}`,
    `  │  conserved     ${r.balanceBefore - r.ethSpent - r.gasCost === r.balanceAfter ? 'yes' : 'NO'}`,
    '  └─',
  ].join('\n');
}
