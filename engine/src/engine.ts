/**
 * The cycle: collect → route → distribute → settle.
 *
 * `runCycle` is pure with respect to the chain — it takes collected data and
 * returns decisions. Nothing here signs or sends. That separation is what makes
 * `--dry-run` meaningful: the dry run and the live run compute the exact same
 * epoch, and the only difference is whether `execute` is called with the result.
 */

import { assertPolicyBalanced, type FaucetConfig } from './config.js';
import { distribute } from './distributor.js';
import { allocate, bucketAmount } from './router.js';
import type {
  Allocation,
  BucketId,
  CollectionResult,
  Epoch,
  FeeSource,
  HolderWeight,
  Raw,
  SettlementIntent,
  SlotWindow,
} from './types.js';

export interface CycleInput {
  readonly config: FaucetConfig;
  readonly epochId: number;
  readonly window: SlotWindow;
  readonly sources: readonly FeeSource[];
  readonly holders: readonly HolderWeight[];
  /** Dust and undistributable drip carried over from the previous epoch. */
  readonly carryIn?: Raw;
  readonly now?: () => Date;
}

export interface CycleResult {
  readonly epoch: Epoch;
  readonly intents: readonly SettlementIntent[];
  readonly settled: boolean;
  readonly skipReason: string | null;
}

export class CycleError extends Error {}

export async function runCycle(input: CycleInput): Promise<CycleResult> {
  const { config, epochId, window, sources, holders } = input;
  const carryIn = input.carryIn ?? 0n;
  const now = input.now ?? (() => new Date());

  assertPolicyBalanced(config.routing);

  if (window.toSlot <= window.fromSlot) {
    throw new CycleError(`epoch ${epochId} has an empty window [${window.fromSlot}, ${window.toSlot})`);
  }

  const openedAt = now().toISOString();

  const collections: CollectionResult[] = [];
  for (const source of sources) {
    collections.push(await source.collect(window));
  }

  const collected = collections.reduce((sum, c) => sum + c.total, 0n) + carryIn;

  // Too small to be worth the transaction fees — roll the whole thing forward
  // rather than spend 0.005 SOL to move 0.002 SOL.
  if (collected < config.epoch.minSettleRaw) {
    const allocations = allocate(0n, config.routing);
    const empty = distribute({ amount: 0n, holders: [], excluded: [], minWeight: 0n });
    return {
      epoch: {
        id: epochId,
        window,
        openedAt,
        closedAt: now().toISOString(),
        collected,
        collections,
        allocations,
        distribution: empty,
        carryIn,
        carryOut: collected,
      },
      intents: [],
      settled: false,
      skipReason: `collected ${collected} is below the ${config.epoch.minSettleRaw} settle floor; carried forward`,
    };
  }

  const allocations = allocate(collected, config.routing);

  const distribution = distribute({
    amount: bucketAmount(allocations, 'drip'),
    holders,
    excluded: config.excludedFromDrip,
    minWeight: config.epoch.minHolderBalanceRaw,
  });

  const epoch: Epoch = {
    id: epochId,
    window,
    openedAt,
    closedAt: now().toISOString(),
    collected,
    collections,
    allocations,
    distribution,
    carryIn,
    // Whatever the drip could not divide evenly funds the next epoch.
    carryOut: distribution.remainder,
  };

  assertConserved(epoch);

  return { epoch, intents: buildIntents(config, epoch), settled: true, skipReason: null };
}

/**
 * The invariant the project is built on: everything collected either left in a
 * settlement intent or is explicitly carried into the next epoch. If this ever
 * throws, the engine has found a leak and refuses to settle.
 */
export function assertConserved(epoch: Epoch): void {
  const routed = epoch.allocations.reduce((sum, a) => sum + a.amount, 0n);
  if (routed !== epoch.collected) {
    throw new CycleError(`epoch ${epoch.id}: routed ${routed} but collected ${epoch.collected}`);
  }

  const drip = epoch.allocations.find((a) => a.bucket === 'drip');
  if (!drip) throw new CycleError(`epoch ${epoch.id}: no drip allocation`);

  const claimed = epoch.distribution.total + epoch.distribution.remainder;
  if (claimed !== drip.amount) {
    throw new CycleError(
      `epoch ${epoch.id}: drip bucket holds ${drip.amount} but claims + remainder are ${claimed}`,
    );
  }

  if (epoch.carryOut !== epoch.distribution.remainder) {
    throw new CycleError(`epoch ${epoch.id}: carry-out does not match undistributed drip`);
  }
}

const ACTIONS: Record<BucketId, SettlementIntent['action']> = {
  buyback: 'buyback-and-burn',
  drip: 'fund-merkle',
  liquidity: 'add-liquidity',
  treasury: 'transfer',
  ops: 'transfer',
};

function buildIntents(config: FaucetConfig, epoch: Epoch): SettlementIntent[] {
  return epoch.allocations
    .filter((allocation) => allocation.amount > 0n)
    .map((allocation: Allocation) => {
      const rule = config.routing.rules.find((r) => r.bucket === allocation.bucket);
      const amount = allocation.bucket === 'drip' ? epoch.distribution.total : allocation.amount;
      return {
        bucket: allocation.bucket,
        action: ACTIONS[allocation.bucket],
        amount,
        destination: allocation.destination,
        memo: `faucet:e${epoch.id}:${allocation.bucket}:${rule?.label ?? allocation.bucket}`,
      };
    })
    .filter((intent) => intent.amount > 0n);
}
