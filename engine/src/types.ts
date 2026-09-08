/**
 * Core domain types for the Faucet buyback engine.
 *
 * Every on-chain amount is a `bigint` of the asset's smallest unit (wei for
 * ETH, raw units for the token). Floats never touch a balance; they only show
 * up in reports, after formatting.
 */

/** A raw on-chain amount, in the smallest unit of its asset. */
export type Raw = bigint;

/** Basis points. 10_000 bps = 100%. */
export type Bps = number;

export const BPS_DENOMINATOR = 10_000 as const;

/** A 0x-prefixed, 20-byte EVM address. */
export type Address = `0x${string}`;

/** The universal burn address. Nothing can ever be moved out of it. */
export const BURN_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';

/** The one bucket. Everything the dev wallet earns goes here. */
export type BucketId = 'buyback';

export interface Asset {
  readonly address: Address | null;
  readonly symbol: string;
  readonly decimals: number;
}

export interface RouteRule {
  readonly bucket: BucketId;
  readonly bps: Bps;
  readonly label: string;
  readonly intent: string;
}

export interface RoutingPolicy {
  readonly rules: readonly RouteRule[];
}

export interface Allocation {
  readonly bucket: BucketId;
  readonly bps: Bps;
  readonly amount: Raw;
}

/** What the engine intends to do, before anything is signed. */
export interface BuybackPlan {
  readonly wallet: Address;
  readonly balance: Raw;
  readonly gasReserve: Raw;
  readonly spend: Raw;
  readonly expectedOut: Raw;
  readonly minOut: Raw;
  readonly slippageBps: Bps;
  readonly path: readonly Address[];
  readonly to: Address;
  readonly deadline: number;
  readonly quotedAtBlock: number;
}

/** Why a cycle did not settle. */
export type SkipReason =
  | { readonly kind: 'below-floor'; readonly spendable: Raw; readonly floor: Raw }
  | { readonly kind: 'unconfigured'; readonly missing: readonly string[] };

/** The record of one settled buyback-and-burn, as persisted and published. */
export interface BurnReceipt {
  readonly id: number;
  readonly txHash: string;
  readonly block: number;
  readonly timestamp: string;
  readonly wallet: Address;
  readonly ethSpent: Raw;
  readonly tokensBurned: Raw;
  readonly expectedOut: Raw;
  readonly minOut: Raw;
  readonly gasUsed: Raw;
  readonly gasCost: Raw;
  readonly balanceBefore: Raw;
  readonly balanceAfter: Raw;
  readonly mode: 'live' | 'mock';
}

/** What the chain reports back for a sent swap. */
export interface SwapReceipt {
  readonly txHash: string;
  readonly status: 'success' | 'reverted';
  readonly block: number;
  readonly timestamp: number;
  readonly gasUsed: Raw;
  readonly effectiveGasPrice: Raw;
  /** Sum of ERC-20 Transfer(to = burn address) amounts for the token in this tx. */
  readonly tokensToBurn: Raw;
}
