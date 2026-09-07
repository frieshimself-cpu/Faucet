/**
 * The single source of truth for the Faucet.
 *
 * The site reads a generated copy of this (see `writeSiteData`), so the numbers
 * on the landing page and the numbers the engine actually settles can never
 * drift apart. Change a bps value here and the pipeline diagram changes too.
 */

import type { Address, BucketId, Bps, Mint, RoutingPolicy } from './types.js';
import { BPS_DENOMINATOR } from './types.js';

export interface FaucetConfig {
  readonly project: {
    readonly name: string;
    readonly ticker: string;
    readonly tagline: string;
    readonly launchpad: string;
    readonly chain: 'solana';
  };
  readonly mint: Mint;
  readonly native: Mint;
  /** Accounts that must never receive a drip (they are the project's own). */
  readonly excludedFromDrip: readonly Address[];
  /** Fee-earning accounts the source adapters watch. */
  readonly feeAccounts: {
    readonly ponsCreatorVault: Address | null;
    readonly lpFeeVault: Address | null;
    readonly treasury: Address | null;
  };
  readonly epoch: {
    /** Target epoch length. Solana averages ~2.5 slots/second. */
    readonly slots: number;
    /** Below this, the epoch rolls forward instead of settling — dust is not worth the fees. */
    readonly minSettleRaw: bigint;
    /** A holder under this balance is not counted; stops sybil dust farming the drip. */
    readonly minHolderBalanceRaw: bigint;
  };
  readonly routing: RoutingPolicy;
}

/**
 * The routing policy. Every basis point lands in something the project owns or
 * the holders own — there is no "team" bucket and no outbound wallet that isn't
 * named here. `assertPolicyBalanced` is what actually enforces the "100% back
 * in" claim on the site; it runs on import and on every cycle.
 */
export const ROUTING: RoutingPolicy = {
  rules: [
    {
      bucket: 'buyback',
      bps: 3_500,
      label: 'Buyback & Burn',
      intent: 'Market-buys the token with collected fees and burns what it buys. Supply only goes down.',
      destination: null,
    },
    {
      bucket: 'drip',
      bps: 3_500,
      label: 'Holder Drip',
      intent: 'Split across eligible holders by time-weighted balance, claimable from the faucet.',
      destination: null,
    },
    {
      bucket: 'liquidity',
      bps: 2_000,
      label: 'Liquidity Deepening',
      intent: 'Paired and added to the pool as protocol-owned liquidity. Never withdrawn.',
      destination: null,
    },
    {
      bucket: 'treasury',
      bps: 1_000,
      label: 'Build Fund',
      intent: 'On-chain treasury for tooling, audits, integrations. Spends are published per epoch.',
      destination: null,
    },
  ],
};

export const CONFIG: FaucetConfig = {
  project: {
    name: 'Robinhood',
    ticker: 'ROBIN',
    tagline: 'Every fee drips back to the people it came from.',
    launchpad: 'Pons',
    chain: 'solana',
  },
  mint: {
    // Set at launch. Until then the engine runs against the mock adapters.
    address: null,
    symbol: 'ROBIN',
    decimals: 6,
  },
  native: {
    address: null,
    symbol: 'SOL',
    decimals: 9,
  },
  excludedFromDrip: [],
  feeAccounts: {
    ponsCreatorVault: null,
    lpFeeVault: null,
    treasury: null,
  },
  epoch: {
    // ~6 hours at 2.5 slots/sec.
    slots: 54_000,
    minSettleRaw: 10_000_000n, // 0.01 SOL
    minHolderBalanceRaw: 1_000_000n, // 1 ROBIN
  },
  routing: ROUTING,
};

export class PolicyError extends Error {}

/**
 * Fails loudly if the routing policy does not allocate exactly 100%, or if a
 * bucket appears twice. This is the invariant the whole project is named after:
 * nothing collected is allowed to fall out of the system.
 */
export function assertPolicyBalanced(policy: RoutingPolicy): void {
  const seen = new Set<BucketId>();
  let total: Bps = 0;

  for (const rule of policy.rules) {
    if (seen.has(rule.bucket)) {
      throw new PolicyError(`duplicate bucket in routing policy: ${rule.bucket}`);
    }
    if (!Number.isInteger(rule.bps) || rule.bps <= 0) {
      throw new PolicyError(`bucket ${rule.bucket} has a non-positive or fractional bps: ${rule.bps}`);
    }
    seen.add(rule.bucket);
    total += rule.bps;
  }

  if (total !== BPS_DENOMINATOR) {
    throw new PolicyError(
      `routing policy allocates ${total} bps, expected exactly ${BPS_DENOMINATOR}. ` +
        `The Faucet only ships when 100% of fees are accounted for.`,
    );
  }
}

assertPolicyBalanced(ROUTING);
