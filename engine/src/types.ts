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

/** Native ETH, as Uniswap v4 and Pons spell it. */
export const NATIVE: Address = '0x0000000000000000000000000000000000000000';

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

/** A Uniswap v4 pool key. Currencies are sorted; native ETH is address zero. */
export interface PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

/**
 * Where the buy happens. A Pons launch trades on its bonding curve until it
 * graduates, then on a Uniswap v4 pool guarded by the Pons hook. Both deliver
 * the tokens straight to whichever address is asked for.
 */
export type Route =
  | { readonly kind: 'pons-curve'; readonly curve: Address }
  | { readonly kind: 'uniswap-v4'; readonly poolKey: PoolKey };

export type Venue = Route['kind'];

/** What the Pons factory knows about a token, plus the two facts that pick the route. */
export interface LaunchInfo {
  readonly token: Address;
  readonly exists: boolean;
  readonly curve: Address;
  readonly deployer: Address;
  /** The address the fee escrow credits creator rewards to. Must be the dev wallet. */
  readonly creatorRecipient: Address;
  /** Address zero means the token is paired with native ETH. */
  readonly pairToken: Address;
  readonly tickSpacing: number;
  readonly graduated: boolean;
  /** Liquidity in the v4 pool; zero before graduation. */
  readonly poolLiquidity: Raw;
}

/**
 * The wallet's balance the moment the engine first saw it, before any claim.
 * Everything up to this amount is left alone forever; only ETH that arrived
 * through a claim is ever spent.
 */
export interface Baseline {
  readonly wallet: Address;
  readonly balance: Raw;
  readonly block: number;
  readonly recordedAt: string;
}

/** What the engine intends to do, before anything is signed. */
export interface BuybackPlan {
  readonly wallet: Address;
  readonly balance: Raw;
  /** The baseline: never spent. */
  readonly untouched: Raw;
  /** Claimed rewards still in the wallet, per the ledger. */
  readonly claimedPool: Raw;
  readonly gasReserve: Raw;
  readonly spend: Raw;
  readonly expectedOut: Raw;
  readonly minOut: Raw;
  readonly slippageBps: Bps;
  readonly route: Route;
  readonly to: Address;
  readonly deadline: number;
  readonly quotedAtBlock: number;
}

/** Why a cycle did not settle. */
export type SkipReason =
  | { readonly kind: 'below-floor'; readonly spendable: Raw; readonly floor: Raw }
  | { readonly kind: 'no-baseline' }
  | { readonly kind: 'unconfigured'; readonly missing: readonly string[] }
  | { readonly kind: 'no-route'; readonly detail: string };

/** One claim of creator rewards from the Pons fee escrow. */
export interface ClaimReceipt {
  readonly txHash: string;
  readonly block: number;
  readonly timestamp: string;
  readonly wallet: Address;
  /** What the escrow said was claimable, and what arrived. */
  readonly amount: Raw;
  readonly gasUsed: Raw;
  readonly gasCost: Raw;
  readonly mode: 'live' | 'mock';
}

/** The record of one settled buyback-and-burn, as persisted and published. */
export interface BurnReceipt {
  readonly id: number;
  readonly txHash: string;
  readonly block: number;
  readonly timestamp: string;
  readonly wallet: Address;
  readonly venue: Venue;
  readonly ethSpent: Raw;
  readonly tokensBurned: Raw;
  readonly expectedOut: Raw;
  readonly minOut: Raw;
  readonly gasUsed: Raw;
  readonly gasCost: Raw;
  readonly balanceBefore: Raw;
  readonly balanceAfter: Raw;
  /** The baseline in force: balanceAfter never falls below it. */
  readonly untouched: Raw;
  /** The claim that fed this burn, when one happened in the same cycle. */
  readonly claimTx: string | null;
  readonly mode: 'live' | 'mock';
}

/** What the chain reports back for a sent transaction. */
export interface TxReceipt {
  readonly txHash: string;
  readonly status: 'success' | 'reverted';
  readonly block: number;
  readonly timestamp: number;
  readonly gasUsed: Raw;
  readonly effectiveGasPrice: Raw;
}

export interface SwapReceipt extends TxReceipt {
  /** Sum of ERC-20 Transfer(to = burn address) amounts for the token in this tx. */
  readonly tokensToBurn: Raw;
}
