import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPolicyBalanced, ROUTING } from '../src/config.js';
import { allocate, bucketAmount } from '../src/router.js';
import type { RouteRule, RoutingPolicy } from '../src/types.js';

test('the shipped policy allocates exactly 100%', () => {
  assert.doesNotThrow(() => assertPolicyBalanced(ROUTING));
  assert.equal(ROUTING.rules.reduce((sum, r) => sum + r.bps, 0), 10_000);
});

test('allocation never loses a single unit, at any amount', () => {
  for (const total of [0n, 1n, 3n, 7n, 9_999n, 10_000n, 10_001n, 123_456_789n, 2n ** 53n + 7n]) {
    const allocations = allocate(total, ROUTING);
    assert.equal(allocations.reduce((acc, a) => acc + a.amount, 0n), total, `total ${total}`);
    assert.equal(bucketAmount(allocations, 'buyback'), total);
  }
});

const FIRST_RULE = ROUTING.rules[0] as RouteRule;

test('a policy that does not sum to 100% is refused', () => {
  const leaky: RoutingPolicy = { rules: [{ ...FIRST_RULE, bps: 9_000 }] };
  assert.throws(() => allocate(100n, leaky), /allocates 9000 bps/);
});

test('a duplicated bucket is refused', () => {
  const dupe: RoutingPolicy = { rules: [{ ...FIRST_RULE, bps: 5_000 }, { ...FIRST_RULE, bps: 5_000 }] };
  assert.throws(() => allocate(100n, dupe), /duplicate bucket/);
});

test('negative totals are refused', () => {
  assert.throws(() => allocate(-1n, ROUTING), /negative total/);
});
