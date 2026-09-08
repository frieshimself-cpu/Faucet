/**
 * The cycle: read the wallet, quote the swap, send it straight to the burn
 * address, and account for every wei.
 *
 * `plan` is pure with respect to money: it reads and computes, nothing is
 * signed. `execute` takes a plan and sends exactly that, then checks the
 * wallet moved by exactly spend + gas. A dry run and a live run compute the
 * same plan; the only difference is whether `execute` is called.
 */

import { assertPolicyBalanced, missingForLive, type FaucetConfig } from './config.js';
import type { Chain } from './evm.js';
import { allocate, bucketAmount } from './router.js';
import type { Address, BurnReceipt, BuybackPlan, Raw, SkipReason } from './types.js';

export class BuybackError extends Error {}

export type PlanResult =
  | { readonly ok: true; readonly plan: BuybackPlan }
  | { readonly ok: false; readonly skip: SkipReason; readonly balance: Raw };

export interface PlanInput {
  readonly config: FaucetConfig;
  readonly chain: Chain;
  /** Overrides for mock runs where the config has no addresses. */
  readonly wallet?: Address;
  readonly token?: Address;
  readonly router?: Address;
  readonly weth?: Address;
  readonly now?: () => number;
}

export async function plan(input: PlanInput): Promise<PlanResult> {
  const { config, chain } = input;
  assertPolicyBalanced(config.routing);

  const wallet = input.wallet ?? config.devWallet;
  const token = input.token ?? config.token.address;
  const router = input.router ?? config.dex.router;
  const weth = input.weth ?? config.dex.weth;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));

  const missing: string[] = [];
  if (!wallet) missing.push('devWallet');
  if (!token) missing.push('token');
  if (!router) missing.push('router');
  if (!weth) missing.push('weth');
  if (missing.length > 0 || !wallet || !token || !router || !weth) {
    return { ok: false, skip: { kind: 'unconfigured', missing }, balance: 0n };
  }

  const balance = await chain.balance(wallet);
  const { gasReserveWei, minBuybackWei, slippageBps, deadlineSeconds } = config.limits;

  // Everything above the gas reserve is the amount to route. The policy has
  // one bucket, but it still goes through `allocate` so the 100% invariant is
  // enforced by the same code path a multi-bucket policy would use.
  const spendable = balance > gasReserveWei ? balance - gasReserveWei : 0n;
  const spend = spendable > 0n ? bucketAmount(allocate(spendable, config.routing), 'buyback') : 0n;

  if (spend < minBuybackWei) {
    return { ok: false, skip: { kind: 'below-floor', spendable: spend, floor: minBuybackWei }, balance };
  }

  const path: readonly Address[] = [weth, token];
  const quotedAtBlock = await chain.blockNumber();
  const expectedOut = await chain.quote(router, spend, path);
  if (expectedOut <= 0n) throw new BuybackError('router quoted zero output; is the pool live?');

  const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const result: BuybackPlan = {
    wallet,
    balance,
    gasReserve: gasReserveWei,
    spend,
    expectedOut,
    minOut,
    slippageBps,
    path,
    to: config.burnAddress,
    deadline: now() + deadlineSeconds,
    quotedAtBlock,
  };

  assertPlanConserved(result);
  return { ok: true, plan: result };
}

/** The plan must account for the whole balance: spend + reserve, nothing else. */
export function assertPlanConserved(p: BuybackPlan): void {
  if (p.spend + p.gasReserve !== p.balance) {
    throw new BuybackError(`plan leaks: spend ${p.spend} + reserve ${p.gasReserve} != balance ${p.balance}`);
  }
  if (p.minOut > p.expectedOut) throw new BuybackError('minOut exceeds the quote');
  if (p.to.toLowerCase() !== '0x000000000000000000000000000000000000dead') {
    throw new BuybackError(`swap recipient ${p.to} is not the burn address`);
  }
}

export interface ExecuteInput {
  readonly config: FaucetConfig;
  readonly chain: Chain;
  readonly plan: BuybackPlan;
  readonly id: number;
  readonly mode: 'live' | 'mock';
  readonly router?: Address;
  readonly token?: Address;
}

export async function execute(input: ExecuteInput): Promise<BurnReceipt> {
  const { config, chain, plan: p, id, mode } = input;
  const router = input.router ?? config.dex.router;
  const token = input.token ?? config.token.address;
  if (!router || !token) throw new BuybackError('cannot execute without router and token');

  assertPlanConserved(p);

  const txHash = await chain.swapToBurn({
    router,
    amountInWei: p.spend,
    amountOutMin: p.minOut,
    path: p.path,
    to: p.to,
    deadline: p.deadline,
  });

  const receipt = await chain.receipt(txHash, token, config.burnAddress);
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const balanceAfter = await chain.balance(p.wallet);

  if (receipt.status !== 'success') {
    throw new BuybackError(
      `swap ${txHash} reverted (slippage over ${p.slippageBps} bps, or the deadline passed). ` +
        `Only gas was spent: ${gasCost} wei.`,
    );
  }

  if (receipt.tokensToBurn <= 0n) {
    throw new BuybackError(`swap ${txHash} succeeded but no ${config.token.symbol} reached ${config.burnAddress}`);
  }

  if (receipt.tokensToBurn < p.minOut) {
    throw new BuybackError(`swap ${txHash} delivered ${receipt.tokensToBurn}, below minOut ${p.minOut}`);
  }

  // The wallet must have moved by exactly what we sent plus what gas cost.
  const expectedAfter = p.balance - p.spend - gasCost;
  if (balanceAfter !== expectedAfter) {
    throw new BuybackError(
      `wallet balance after swap is ${balanceAfter}, expected ${expectedAfter} ` +
        `(balance ${p.balance} - spend ${p.spend} - gas ${gasCost})`,
    );
  }

  if (gasCost > p.gasReserve) {
    throw new BuybackError(`gas ${gasCost} exceeded the reserve ${p.gasReserve}; raise limits.gasReserveWei`);
  }

  return {
    id,
    txHash,
    block: receipt.block,
    timestamp: new Date(receipt.timestamp * 1000).toISOString(),
    wallet: p.wallet,
    ethSpent: p.spend,
    tokensBurned: receipt.tokensToBurn,
    expectedOut: p.expectedOut,
    minOut: p.minOut,
    gasUsed: receipt.gasUsed,
    gasCost,
    balanceBefore: p.balance,
    balanceAfter,
    mode,
  };
}

/** True when the config has everything a live cycle needs. */
export function readyForLive(config: FaucetConfig): boolean {
  return missingForLive(config).length === 0;
}
