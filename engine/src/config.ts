/**
 * The single source of truth for the Faucet.
 *
 * The site reads a generated copy of this, so the numbers on the page and the
 * numbers the engine settles with can never drift apart.
 *
 * Chain and venue addresses default to Robinhood Chain mainnet and the Pons
 * v2 contracts, all of which were verified by simulation against the live
 * chain (see pons.ts). Only two things are launch-specific and must come from
 * the environment: the token, and the dev wallet Pons credits rewards to.
 */

import { PONS, ROBINHOOD_CHAIN, UNISWAP_V4 } from './pons.js';
import type { Address, Asset, BucketId, Bps, RoutingPolicy } from './types.js';
import { BPS_DENOMINATOR, BURN_ADDRESS } from './types.js';

export interface FaucetConfig {
  readonly project: {
    readonly name: string;
    readonly ticker: string;
    readonly tagline: string;
    readonly launchpad: string;
    readonly chain: string;
  };
  readonly chain: {
    readonly chainId: number;
    readonly rpcUrl: string;
    /** Prefix for a transaction link. */
    readonly explorerTx: string;
  };
  readonly token: Asset;
  readonly native: Asset;
  /** The wallet Pons credits creator rewards to. Claims them and signs the buybacks. */
  readonly devWallet: Address | null;
  readonly burnAddress: Address;
  /** Pons v2 launch contracts. */
  readonly pons: {
    readonly factory: Address;
    readonly hook: Address;
    readonly feeEscrow: Address;
  };
  /** Uniswap v4, where a graduated Pons token trades. */
  readonly uniswapV4: {
    readonly poolManager: Address;
    readonly universalRouter: Address;
    readonly quoter: Address;
    readonly stateView: Address;
  };
  readonly limits: {
    /** Left in the wallet so the next cycle can always pay for gas. */
    readonly gasReserveWei: bigint;
    /** Below this, nothing is bought; a tiny swap is mostly gas. */
    readonly minBuybackWei: bigint;
    /** Below this, rewards are left in the escrow for a later cycle. */
    readonly minClaimWei: bigint;
    /** Maximum accepted drop from the quote before the swap reverts. */
    readonly slippageBps: Bps;
    /** How long a signed swap stays valid. */
    readonly deadlineSeconds: number;
    /** How often the runner cycles. */
    readonly intervalSeconds: number;
  };
  readonly routing: RoutingPolicy;
}

/**
 * One rule. Every basis point of creator rewards is spent buying the token,
 * and the buy delivers straight to the burn address, so the tokens never sit
 * in a wallet anyone controls.
 */
export const ROUTING: RoutingPolicy = {
  rules: [
    {
      bucket: 'buyback',
      bps: 10_000,
      label: 'Buyback & burn',
      intent:
        'Every creator reward claimed from the Pons fee escrow is spent buying the token, ' +
        'on its bonding curve before graduation and on the Uniswap v4 pool after, ' +
        'with the tokens delivered directly to the burn address.',
    },
  ],
};

export const CONFIG: FaucetConfig = {
  project: {
    name: 'Robinhood',
    ticker: 'ROBIN',
    tagline: 'Every creator reward buys the coin back and burns it.',
    launchpad: 'Pons',
    chain: ROBINHOOD_CHAIN.name,
  },
  chain: {
    chainId: envInt('FAUCET_CHAIN_ID') ?? ROBINHOOD_CHAIN.chainId,
    rpcUrl: process.env['FAUCET_RPC_URL'] ?? ROBINHOOD_CHAIN.rpcUrl,
    explorerTx: process.env['FAUCET_EXPLORER_TX'] ?? ROBINHOOD_CHAIN.explorerTx,
  },
  token: {
    address: envAddress('FAUCET_TOKEN'),
    symbol: process.env['FAUCET_TOKEN_SYMBOL'] ?? 'ROBIN',
    decimals: 18,
  },
  native: {
    address: null,
    symbol: 'ETH',
    decimals: 18,
  },
  devWallet: envAddress('FAUCET_DEV_WALLET'),
  burnAddress: BURN_ADDRESS,
  pons: {
    factory: envAddress('FAUCET_PONS_FACTORY') ?? PONS.factory,
    hook: envAddress('FAUCET_PONS_HOOK') ?? PONS.hook,
    feeEscrow: envAddress('FAUCET_PONS_FEE_ESCROW') ?? PONS.feeEscrow,
  },
  uniswapV4: {
    poolManager: UNISWAP_V4.poolManager,
    universalRouter: envAddress('FAUCET_V4_UNIVERSAL_ROUTER') ?? UNISWAP_V4.universalRouter,
    quoter: envAddress('FAUCET_V4_QUOTER') ?? UNISWAP_V4.quoter,
    stateView: envAddress('FAUCET_V4_STATE_VIEW') ?? UNISWAP_V4.stateView,
  },
  limits: {
    // Gas on Robinhood Chain is ~0.3 gwei: a claim costs ~42k gas and a buy
    // ~105k (curve) or ~160k (v4), so 0.001 ETH covers many cycles.
    gasReserveWei: envWei('FAUCET_GAS_RESERVE_WEI') ?? 1_000_000_000_000_000n, // 0.001 ETH
    minBuybackWei: envWei('FAUCET_MIN_BUYBACK_WEI') ?? 2_000_000_000_000_000n, // 0.002 ETH
    minClaimWei: envWei('FAUCET_MIN_CLAIM_WEI') ?? 500_000_000_000_000n, // 0.0005 ETH
    slippageBps: 300, // 3%
    deadlineSeconds: 180,
    intervalSeconds: 180,
  },
  routing: ROUTING,
};

export class PolicyError extends Error {}

/**
 * Fails loudly if the routing policy does not allocate exactly 100%. This is
 * the invariant the whole project is named after: nothing collected is
 * allowed to fall out of the system.
 */
export function assertPolicyBalanced(policy: RoutingPolicy): void {
  const seen = new Set<BucketId>();
  let total: Bps = 0;

  for (const rule of policy.rules) {
    if (seen.has(rule.bucket)) throw new PolicyError(`duplicate bucket in routing policy: ${rule.bucket}`);
    if (!Number.isInteger(rule.bps) || rule.bps <= 0) {
      throw new PolicyError(`bucket ${rule.bucket} has a non-positive or fractional bps: ${rule.bps}`);
    }
    seen.add(rule.bucket);
    total += rule.bps;
  }

  if (total !== BPS_DENOMINATOR) {
    throw new PolicyError(
      `routing policy allocates ${total} bps, expected exactly ${BPS_DENOMINATOR}. ` +
        `The Faucet only ships when 100% of rewards are accounted for.`,
    );
  }
}

/** Which live-mode settings are still missing. Empty means ready. */
export function missingForLive(config: FaucetConfig): string[] {
  const missing: string[] = [];
  if (!config.token.address) missing.push('FAUCET_TOKEN');
  if (!config.devWallet) missing.push('FAUCET_DEV_WALLET');
  return missing;
}

function envAddress(name: string): Address | null {
  const value = process.env[name];
  if (!value) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new PolicyError(`${name} is not a 20-byte hex address: ${value}`);
  return value as Address;
}

function envInt(name: string): number | null {
  const value = process.env[name];
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new PolicyError(`${name} must be a positive integer, got ${value}`);
  return n;
}

function envWei(name: string): bigint | null {
  const value = process.env[name];
  if (!value) return null;
  if (!/^\d+$/.test(value)) throw new PolicyError(`${name} must be a whole number of wei, got ${value}`);
  return BigInt(value);
}

assertPolicyBalanced(ROUTING);
