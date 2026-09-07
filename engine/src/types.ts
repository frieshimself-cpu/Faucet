/**
 * Core domain types for the Faucet fee-recycling engine.
 *
 * Everything that represents an on-chain amount is a `bigint` of the token's
 * smallest unit (lamports for SOL, raw units for an SPL token). Floats never
 * touch a balance — they only show up in reports, after formatting.
 */

/** A raw on-chain amount, in the smallest unit of its mint. */
export type Raw = bigint;

/** Basis points. 10_000 bps = 100%. */
export type Bps = number;

export const BPS_DENOMINATOR = 10_000 as const;

/** An address, in whatever encoding the chain adapter uses (base58 for Solana). */
export type Address = string;

/** Where a fee came from. Each one maps to a `FeeSource` adapter. */
export type FeeSourceKind =
  | 'pons-launch-fee'
  | 'pons-creator-fee'
  | 'lp-trading-fee'
  | 'transfer-hook-fee'
  | 'manual-donation';

/** One bucket the fees can be routed into. */
export type BucketId =
  | 'buyback'
  | 'drip'
  | 'liquidity'
  | 'treasury'
  | 'ops';

export interface Mint {
  /** Mint address. `null` means the chain's native asset (SOL). */
  readonly address: Address | null;
  readonly symbol: string;
  readonly decimals: number;
}

/** A half-open window `[fromSlot, toSlot)` that an epoch covers. */
export interface SlotWindow {
  readonly fromSlot: number;
  readonly toSlot: number;
}

/** A single fee receipt observed by a source adapter. */
export interface FeeReceipt {
  readonly source: FeeSourceKind;
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly amount: Raw;
  readonly mint: Mint;
}

/** What a source adapter returns for one collection pass. */
export interface CollectionResult {
  readonly source: FeeSourceKind;
  readonly window: SlotWindow;
  readonly receipts: readonly FeeReceipt[];
  readonly total: Raw;
}

/**
 * A fee source. Adapters are deliberately dumb: they observe, they never move
 * funds. Routing and settlement live downstream so a bad adapter can't spend.
 */
export interface FeeSource {
  readonly kind: FeeSourceKind;
  readonly label: string;
  collect(window: SlotWindow): Promise<CollectionResult>;
}

/** One routing rule: send `bps` of everything collected to `bucket`. */
export interface RouteRule {
  readonly bucket: BucketId;
  readonly bps: Bps;
  readonly label: string;
  /** Human-readable statement of what this bucket does with the money. */
  readonly intent: string;
  /**
   * Destination for the funds. `null` means the bucket is consumed in-protocol
   * (buyback burns, drip is claimed via Merkle) rather than paid to an address.
   */
  readonly destination: Address | null;
}

export interface RoutingPolicy {
  readonly rules: readonly RouteRule[];
}

/** The result of applying a `RoutingPolicy` to a collected total. */
export interface Allocation {
  readonly bucket: BucketId;
  readonly bps: Bps;
  readonly amount: Raw;
  readonly destination: Address | null;
}

/** A holder and the weight that decides their share of the drip bucket. */
export interface HolderWeight {
  readonly owner: Address;
  /** Time-weighted balance across the epoch, raw units. */
  readonly weight: Raw;
}

/** One holder's claimable amount for one epoch. */
export interface Claim {
  readonly index: number;
  readonly owner: Address;
  readonly amount: Raw;
}

export interface MerkleDistribution {
  readonly root: string;
  readonly claims: readonly Claim[];
  readonly total: Raw;
  /** Dust left over after integer division, rolled into the next epoch. */
  readonly remainder: Raw;
}

/** Everything the engine decided for one epoch. Serialised as the audit trail. */
export interface Epoch {
  readonly id: number;
  readonly window: SlotWindow;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly collected: Raw;
  readonly collections: readonly CollectionResult[];
  readonly allocations: readonly Allocation[];
  readonly distribution: MerkleDistribution;
  readonly carryIn: Raw;
  readonly carryOut: Raw;
}

/** A settlement instruction the executor will turn into a transaction. */
export interface SettlementIntent {
  readonly bucket: BucketId;
  readonly action: 'buyback-and-burn' | 'add-liquidity' | 'transfer' | 'fund-merkle';
  readonly amount: Raw;
  readonly destination: Address | null;
  readonly memo: string;
}
