/**
 * The single source of truth for the Faucet.
 *
 * The site reads a generated copy of this, so the numbers on the page and the
 * numbers the engine settles with can never drift apart.
 *
 * Chain constants are deliberately null until they are confirmed against the
 * Robinhood Chain and Pons documentation for the launch. `faucet doctor`
 * refuses to run live until every one of them is set.
 */

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
    /** Set from the chain's published docs at launch. */
    readonly chainId: number | null;
    /** From FAUCET_RPC_URL. */
    readonly rpcUrl: string | null;
    /** Prefix for a transaction link, e.g. "https://explorer.example/tx/". */
    readonly explorerTx: string | null;
  };
  readonly token: Asset;
  readonly native: Asset;
  /** The wallet Pons pays creator rewards into. Signs the buybacks. */
  readonly devWallet: Address | null;
  readonly burnAddress: Address;
  readonly dex: {
    readonly kind: 'uniswap-v2';
    /** UniswapV2Router02-compatible router on Robinhood Chain. */
    readonly router: Address | null;
    /** Wrapped native token the router paths through. */
    readonly weth: Address | null;
  };
  readonly limits: {
    /** Left in the wallet so the next cycle can always pay for gas. */
    readonly gasReserveWei: bigint;
    /** Below this, nothing is bought; a tiny swap is mostly gas. */
    readonly minBuybackWei: bigint;
    /** Maximum accepted drop from the quote before the swap reverts. */
    readonly slippageBps: Bps;
    /** How long a signed swap stays valid. */
    readonly deadlineSeconds: number;
  };
  readonly routing: RoutingPolicy;
}

/**
 * One rule. Every basis point of creator rewards is spent buying the token
 * and the swap delivers straight to the burn address, so the tokens never
 * sit in a wallet anyone controls.
 */
export const ROUTING: RoutingPolicy = {
  rules: [
    {
      bucket: 'buyback',
      bps: 10_000,
      label: 'Buyback & burn',
      intent:
        'Every creator reward the dev wallet receives is swapped for the token on the DEX, ' +
        'with the swap output sent directly to the burn address.',
    },
  ],
};

export const CONFIG: FaucetConfig = {
  project: {
    name: 'Robinhood',
    ticker: 'ROBIN',
    tagline: 'Every creator reward buys the coin back and burns it.',
    launchpad: 'Pons',
    chain: 'Robinhood Chain',
  },
  chain: {
    chainId: envInt('FAUCET_CHAIN_ID'),
    rpcUrl: process.env['FAUCET_RPC_URL'] ?? null,
    explorerTx: process.env['FAUCET_EXPLORER_TX'] ?? null,
  },
  token: {
    address: envAddress('FAUCET_TOKEN'),
    symbol: 'ROBIN',
    decimals: 18,
  },
  native: {
    address: null,
    symbol: 'ETH',
    decimals: 18,
  },
  devWallet: envAddress('FAUCET_DEV_WALLET'),
  burnAddress: BURN_ADDRESS,
  dex: {
    kind: 'uniswap-v2',
    router: envAddress('FAUCET_ROUTER'),
    weth: envAddress('FAUCET_WETH'),
  },
  limits: {
    gasReserveWei: 2_000_000_000_000_000n, // 0.002 ETH
    minBuybackWei: 5_000_000_000_000_000n, // 0.005 ETH
    slippageBps: 300, // 3%
    deadlineSeconds: 180,
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
  if (!config.chain.rpcUrl) missing.push('FAUCET_RPC_URL');
  if (config.chain.chainId === null) missing.push('FAUCET_CHAIN_ID');
  if (!config.token.address) missing.push('FAUCET_TOKEN');
  if (!config.devWallet) missing.push('FAUCET_DEV_WALLET');
  if (!config.dex.router) missing.push('FAUCET_ROUTER');
  if (!config.dex.weth) missing.push('FAUCET_WETH');
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

assertPolicyBalanced(ROUTING);
