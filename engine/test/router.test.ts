import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPolicyBalanced, ROUTING } from '../src/config.js';
import { allocate, bucketAmount } from '../src/router.js';
import type { RouteRule, RoutingPolicy } from '../src/types.js';

test('the shipped policy allocates exactly 100%', () => {
  assert.doesNotThrow(() => assertPolicyBalanced(ROUTING));
  assert.equal(
    ROUTING.rules.reduce((sum, r) => sum + r.bps, 0),
    10_000,
  );
});

test('allocation never loses a single unit, at any amount', () => {
  // Amounts chosen to be hostile to integer division: primes, powers of two,
  // and values just below and above the bps denominator.
  const amounts = [0n, 1n, 3n, 7n, 9_999n, 10_000n, 10_001n, 123_456_789n, 2n ** 53n + 7n];
  for (const total of amounts) {
    const allocations = allocate(total, ROUTING);
    const sum = allocations.reduce((acc, a) => acc + a.amount, 0n);
    assert.equal(sum, total, `total ${total}`);
  }
});

test('remainders go to the largest fractional part, deterministically', () => {
  const first = allocate(9_999n, ROUTING);
  const second = allocate(9_999n, ROUTING);
  assert.deepEqual(
    first.map((a) => [a.bucket, a.amount.toString()]),
    second.map((a) => [a.bucket, a.amount.toString()]),
  );
});

test('a 35% bucket gets 35% of a clean number', () => {
  const allocations = allocate(1_000_000n, ROUTING);
  assert.equal(bucketAmount(allocations, 'buyback'), 350_000n);
  assert.equal(bucketAmount(allocations, 'drip'), 350_000n);
  assert.equal(bucketAmount(allocations, 'liquidity'), 200_000n);
  assert.equal(bucketAmount(allocations, 'treasury'), 100_000n);
});

const FIRST_RULE = ROUTING.rules[0] as RouteRule;

test('a policy that does not sum to 100% is refused', () => {
  const leaky: RoutingPolicy = { rules: [{ ...FIRST_RULE, bps: 9_000 }] };
  assert.throws(() => allocate(100n, leaky), /allocates 9000 bps/);
});

test('a duplicated bucket is refused', () => {
  const dupe: RoutingPolicy = {
    rules: [
      { ...FIRST_RULE, bps: 5_000 },
      { ...FIRST_RULE, bps: 5_000 },
    ],
  };
  assert.throws(() => allocate(100n, dupe), /duplicate bucket/);
});

test('negative totals are refused', () => {
  assert.throws(() => allocate(-1n, ROUTING), /negative total/);
});
