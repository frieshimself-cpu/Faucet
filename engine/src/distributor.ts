/**
 * Turns the drip bucket into per-holder claims.
 *
 * Share is proportional to time-weighted balance, not the balance at a snapshot
 * block. Snapshots are trivially gamed: borrow, hold for one slot, claim, repay.
 * Time-weighting makes the attack cost the full epoch.
 */

import { buildTree, proofFor } from './merkle.js';
import type { Address, Claim, HolderWeight, MerkleDistribution, Raw } from './types.js';

export class DistributionError extends Error {}

export interface DistributionInput {
  readonly amount: Raw;
  readonly holders: readonly HolderWeight[];
  readonly excluded: readonly Address[];
  readonly minWeight: Raw;
}

/**
 * Integrates balance over the epoch: sum(balance_i * slots_held_i) / total_slots.
 * Callers that only have a single snapshot can pass one sample spanning the
 * whole window and get snapshot behaviour, at their own risk.
 */
export interface BalanceSample {
  readonly owner: Address;
  readonly balance: Raw;
  readonly fromSlot: number;
  readonly toSlot: number;
}

export function timeWeight(samples: readonly BalanceSample[], totalSlots: number): HolderWeight[] {
  if (totalSlots <= 0) throw new DistributionError(`epoch must span at least one slot, got ${totalSlots}`);

  const acc = new Map<Address, Raw>();
  const span = BigInt(totalSlots);

  for (const sample of samples) {
    const heldFor = sample.toSlot - sample.fromSlot;
    if (heldFor < 0) {
      throw new DistributionError(`sample for ${sample.owner} ends before it starts`);
    }
    if (heldFor === 0 || sample.balance === 0n) continue;
    const contribution = (sample.balance * BigInt(heldFor)) / span;
    acc.set(sample.owner, (acc.get(sample.owner) ?? 0n) + contribution);
  }

  return [...acc.entries()]
    .map(([owner, weight]) => ({ owner, weight }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
}

/**
 * Builds the claim set. Any amount that cannot be divided evenly stays in
 * `remainder` and the caller rolls it into the next epoch's collected total —
 * it is never burned by rounding and never silently kept.
 */
export function distribute(input: DistributionInput): MerkleDistribution {
  const { amount, holders, excluded, minWeight } = input;

  if (amount < 0n) throw new DistributionError(`cannot distribute a negative amount: ${amount}`);

  const excludedSet = new Set(excluded);
  const eligible = holders
    .filter((h) => !excludedSet.has(h.owner))
    .filter((h) => h.weight >= minWeight && h.weight > 0n)
    // Deterministic ordering: the claim index must be reproducible by anyone
    // rebuilding the tree from the published snapshot.
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));

  const totalWeight = eligible.reduce((sum, h) => sum + h.weight, 0n);

  if (eligible.length === 0 || totalWeight === 0n || amount === 0n) {
    const { root } = buildTree([]);
    return { root, claims: [], total: 0n, remainder: amount };
  }

  const claims: Claim[] = [];
  let handedOut = 0n;

  eligible.forEach((holder, index) => {
    const share = (amount * holder.weight) / totalWeight;
    if (share === 0n) return; // Below one raw unit; their weight rolls forward.
    claims.push({ index: claims.length, owner: holder.owner, amount: share });
    handedOut += share;
    void index;
  });

  if (handedOut > amount) {
    throw new DistributionError(`distribution overspent: ${handedOut} > ${amount}`);
  }

  const { root } = buildTree(claims);

  return { root, claims, total: handedOut, remainder: amount - handedOut };
}

/** Convenience for the claim UI: everything one owner needs to call `claim`. */
export function claimPackage(
  distribution: MerkleDistribution,
  owner: Address,
): { claim: Claim; proof: string[]; root: string } | null {
  const claim = distribution.claims.find((c) => c.owner === owner);
  if (!claim) return null;
  const tree = buildTree(distribution.claims);
  return { claim, proof: proofFor(tree, claim.index), root: distribution.root };
}
