/**
 * The cycle: claim what Pons owes the wallet, read the wallet, quote the
 * buy, send it straight to the burn address, and account for every wei.
 *
 * `claim` and `execute` are the only functions that sign. `plan` is pure with
 * respect to money: it reads and computes. A dry run and a live run compute
 * the same plan; the only difference is whether `execute` is called.
 */

import { assertPolicyBalanced, missingForLive, type FaucetConfig } from './config.js';
import { SwapRejectedError, type Chain } from './evm.js';
import { poolKeyFor } from './pons.js';
import { allocate, bucketAmount } from './router.js';
import { NATIVE, type Address, type BurnReceipt, type BuybackPlan, type ClaimReceipt, type LaunchInfo, type Raw, type Route, type SkipReason } from './types.js';

export class BuybackError extends Error {}

export interface CycleInput {
  readonly config: FaucetConfig;
  readonly chain: Chain;
  /** Overrides for mock runs where the config has no addresses. */
  readonly wallet?: Address;
  readonly token?: Address;
  readonly now?: () => number;
}

/* ── claim ───────────────────────────────────────────────────────────────── */

export type ClaimResult =
  | { readonly ok: true; readonly receipt: ClaimReceipt }
  | { readonly ok: false; readonly skip: 'unconfigured' | 'nothing-claimable' | 'below-minimum'; readonly claimable: Raw };

/**
 * Pulls creator rewards out of the Pons fee escrow into the wallet. The
 * escrow reverts on an empty claim, and a dust claim is mostly gas, so both
 * are skipped rather than sent.
 */
export async function claimRewards(input: CycleInput & { readonly mode: 'live' | 'mock' }): Promise<ClaimResult> {
  const { config, chain, mode } = input;
  const wallet = input.wallet ?? config.devWallet;
  if (!wallet) return { ok: false, skip: 'unconfigured', claimable: 0n };

  const claimable = await chain.claimable(wallet);
  if (claimable === 0n) return { ok: false, skip: 'nothing-claimable', claimable };
  if (claimable < config.limits.minClaimWei) return { ok: false, skip: 'below-minimum', claimable };

  const balanceBefore = await chain.balance(wallet);
  let txHash: string;
  try {
    txHash = await chain.claim();
  } catch (error) {
    if (error instanceof SwapRejectedError) throw new BuybackError(`claim rejected before sending: ${error.message}`);
    throw error;
  }

  const receipt = await chain.txReceipt(txHash);
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  if (receipt.status !== 'success') throw new BuybackError(`claim ${txHash} reverted; only gas was spent: ${gasCost} wei`);

  const balanceAfter = await chain.balance(wallet);
  const arrived = balanceAfter - balanceBefore + gasCost;
  if (arrived !== claimable) {
    throw new BuybackError(`claim ${txHash}: escrow said ${claimable} wei, wallet received ${arrived} wei`);
  }

  return {
    ok: true,
    receipt: {
      txHash,
      block: receipt.block,
      timestamp: new Date(receipt.timestamp * 1000).toISOString(),
      wallet,
      amount: arrived,
      gasUsed: receipt.gasUsed,
      gasCost,
      mode,
    },
  };
}

/* ── plan ────────────────────────────────────────────────────────────────── */

export type PlanResult =
  | { readonly ok: true; readonly plan: BuybackPlan; readonly launch: LaunchInfo }
  | { readonly ok: false; readonly skip: SkipReason; readonly balance: Raw };

/** Picks the venue from the launch record. A string is the reason there is none. */
export function routeFor(launch: LaunchInfo, hook: Address): Route | string {
  if (!launch.exists) return `${launch.token} is not a Pons v2 launch (no factory record)`;
  if (launch.pairToken !== NATIVE) return `token is paired with ${launch.pairToken}, not ETH; rewards would not be ETH`;
  if (!launch.graduated) return { kind: 'pons-curve', curve: launch.curve };
  if (launch.poolLiquidity === 0n) return 'token graduated but its Uniswap v4 pool has no liquidity yet';
  return { kind: 'uniswap-v4', poolKey: poolKeyFor(launch.token, launch.tickSpacing, hook) };
}

export async function plan(input: CycleInput): Promise<PlanResult> {
  const { config, chain } = input;
  assertPolicyBalanced(config.routing);

  const wallet = input.wallet ?? config.devWallet;
  const token = input.token ?? config.token.address;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));

  const missing: string[] = [];
  if (!wallet) missing.push('devWallet');
  if (!token) missing.push('token');
  if (!wallet || !token) return { ok: false, skip: { kind: 'unconfigured', missing }, balance: 0n };

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

  const launch = await chain.launch(token);
  const route = routeFor(launch, config.pons.hook);
  if (typeof route === 'string') return { ok: false, skip: { kind: 'no-route', detail: route }, balance };

  const quotedAtBlock = await chain.blockNumber();
  const expectedOut = await chain.quote(route, token, spend, wallet);
  if (expectedOut <= 0n) throw new BuybackError('the venue quoted zero output; is the market live?');

  const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const result: BuybackPlan = {
    wallet,
    balance,
    gasReserve: gasReserveWei,
    spend,
    expectedOut,
    minOut,
    slippageBps,
    route,
    to: config.burnAddress,
    deadline: now() + deadlineSeconds,
    quotedAtBlock,
  };

  assertPlanConserved(result);
  return { ok: true, plan: result, launch };
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

/* ── execute ─────────────────────────────────────────────────────────────── */

export interface ExecuteInput {
  readonly config: FaucetConfig;
  readonly chain: Chain;
  readonly plan: BuybackPlan;
  readonly id: number;
  readonly mode: 'live' | 'mock';
  readonly token?: Address;
  readonly claimTx?: string | null;
}

export async function execute(input: ExecuteInput): Promise<BurnReceipt> {
  const { config, chain, plan: p, id, mode } = input;
  const token = input.token ?? config.token.address;
  if (!token) throw new BuybackError('cannot execute without a token');

  assertPlanConserved(p);

  let txHash: string;
  try {
    txHash = await chain.swapToBurn({
      route: p.route,
      token,
      amountInWei: p.spend,
      amountOutMin: p.minOut,
      to: p.to,
      deadline: p.deadline,
    });
  } catch (error) {
    if (error instanceof SwapRejectedError) {
      throw new BuybackError(
        `buy rejected before sending: ${error.message}. Nothing was signed and no gas was spent; ` +
          `the market moved more than ${p.slippageBps} bps from the quote, or the deadline passed.`,
      );
    }
    throw error;
  }

  const receipt = await chain.receipt(txHash, token, config.burnAddress);
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const balanceAfter = await chain.balance(p.wallet);

  if (receipt.status !== 'success') {
    throw new BuybackError(
      `buy ${txHash} reverted (slippage over ${p.slippageBps} bps, or the deadline passed). ` +
        `Only gas was spent: ${gasCost} wei.`,
    );
  }

  if (receipt.tokensToBurn <= 0n) {
    throw new BuybackError(`buy ${txHash} succeeded but no ${config.token.symbol} reached ${config.burnAddress}`);
  }

  if (receipt.tokensToBurn < p.minOut) {
    throw new BuybackError(`buy ${txHash} delivered ${receipt.tokensToBurn}, below minOut ${p.minOut}`);
  }

  // The wallet must have moved by exactly what we sent plus what gas cost.
  const expectedAfter = p.balance - p.spend - gasCost;
  if (balanceAfter !== expectedAfter) {
    throw new BuybackError(
      `wallet balance after buy ${txHash} is ${balanceAfter}, expected ${expectedAfter} ` +
        `(balance ${p.balance} - spend ${p.spend} - gas ${gasCost})`,
    );
  }

  if (gasCost > p.gasReserve) {
    throw new BuybackError(`gas ${gasCost} exceeded the reserve ${p.gasReserve}; raise FAUCET_GAS_RESERVE_WEI`);
  }

  return {
    id,
    txHash,
    block: receipt.block,
    timestamp: new Date(receipt.timestamp * 1000).toISOString(),
    wallet: p.wallet,
    venue: p.route.kind,
    ethSpent: p.spend,
    tokensBurned: receipt.tokensToBurn,
    expectedOut: p.expectedOut,
    minOut: p.minOut,
    gasUsed: receipt.gasUsed,
    gasCost,
    balanceBefore: p.balance,
    balanceAfter,
    claimTx: input.claimTx ?? null,
    mode,
  };
}

/** True when the config has everything a live cycle needs. */
export function readyForLive(config: FaucetConfig): boolean {
  return missingForLive(config).length === 0;
}
