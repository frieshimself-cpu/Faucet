/**
 * Splits a collected total across the routing policy's buckets.
 *
 * Integer division loses remainders, and "we lost 3 lamports per epoch" is
 * exactly the kind of leak the project promises doesn't exist. So allocation
 * uses the largest-remainder method: floor everything, then hand the leftover
 * units out one at a time to the buckets with the largest fractional part.
 * `sum(allocations) === total` is guaranteed, and asserted.
 */

import { assertPolicyBalanced } from './config.js';
import type { Allocation, BucketId, Raw, RoutingPolicy } from './types.js';
import { BPS_DENOMINATOR } from './types.js';

export class RoutingError extends Error {}

export function allocate(total: Raw, policy: RoutingPolicy): Allocation[] {
  assertPolicyBalanced(policy);

  if (total < 0n) throw new RoutingError(`cannot route a negative total: ${total}`);

  const denominator = BigInt(BPS_DENOMINATOR);

  const scratch = policy.rules.map((rule) => {
    const numerator = total * BigInt(rule.bps);
    return {
      rule,
      floor: numerator / denominator,
      remainder: numerator % denominator,
    };
  });

  let distributed = scratch.reduce((sum, row) => sum + row.floor, 0n);
  let leftover = total - distributed;

  // Ties break on bucket order, which is fixed in config — so the same input
  // always produces the same allocation, on any machine, forever.
  const byRemainder = [...scratch].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return policy.rules.indexOf(a.rule) - policy.rules.indexOf(b.rule);
  });

  const bonus = new Map<BucketId, Raw>();
  for (const row of byRemainder) {
    if (leftover <= 0n) break;
    bonus.set(row.rule.bucket, 1n);
    leftover -= 1n;
    distributed += 1n;
  }

  const allocations: Allocation[] = scratch.map((row) => ({
    bucket: row.rule.bucket,
    bps: row.rule.bps,
    amount: row.floor + (bonus.get(row.rule.bucket) ?? 0n),
  }));

  const check = allocations.reduce((sum, a) => sum + a.amount, 0n);
  if (check !== total) {
    throw new RoutingError(`allocation lost funds: routed ${check} of ${total}`);
  }

  return allocations;
}

export function bucketAmount(allocations: readonly Allocation[], bucket: BucketId): Raw {
  const found = allocations.find((a) => a.bucket === bucket);
  if (!found) throw new RoutingError(`no allocation for bucket ${bucket}`);
  return found.amount;
}
