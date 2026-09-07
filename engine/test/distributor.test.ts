import assert from 'node:assert/strict';
import test from 'node:test';
import { claimPackage, distribute, timeWeight } from '../src/distributor.js';
import { verifyProof } from '../src/merkle.js';
import type { HolderWeight } from '../src/types.js';

const holders: HolderWeight[] = [
  { owner: 'alice', weight: 500n },
  { owner: 'bob', weight: 300n },
  { owner: 'carol', weight: 200n },
];

test('shares are proportional to weight', () => {
  const result = distribute({ amount: 1_000n, holders, excluded: [], minWeight: 0n });
  const byOwner = new Map(result.claims.map((c) => [c.owner, c.amount]));
  assert.equal(byOwner.get('alice'), 500n);
  assert.equal(byOwner.get('bob'), 300n);
  assert.equal(byOwner.get('carol'), 200n);
  assert.equal(result.remainder, 0n);
});

test('nothing is created or destroyed: claims + remainder equal the bucket', () => {
  for (const amount of [1n, 7n, 999n, 1_000_003n, 2n ** 40n + 13n]) {
    const result = distribute({ amount, holders, excluded: [], minWeight: 0n });
    const claimed = result.claims.reduce((sum, c) => sum + c.amount, 0n);
    assert.equal(claimed, result.total);
    assert.equal(result.total + result.remainder, amount, `amount ${amount}`);
  }
});

test('excluded accounts get nothing and do not dilute the rest', () => {
  const result = distribute({ amount: 1_000n, holders, excluded: ['bob'], minWeight: 0n });
  assert.equal(result.claims.some((c) => c.owner === 'bob'), false);
  // alice:carol is 500:200, so alice takes 5/7 of 1000.
  const byOwner = new Map(result.claims.map((c) => [c.owner, c.amount]));
  assert.equal(byOwner.get('alice'), 714n);
  assert.equal(byOwner.get('carol'), 285n);
});

test('dust holders below the floor are skipped', () => {
  const withDust = [...holders, { owner: 'dust', weight: 1n }];
  const result = distribute({ amount: 1_000n, holders: withDust, excluded: [], minWeight: 100n });
  assert.equal(result.claims.some((c) => c.owner === 'dust'), false);
  assert.equal(result.claims.length, 3);
});

test('an epoch with no eligible holders carries the whole bucket forward', () => {
  const result = distribute({ amount: 5_000n, holders: [], excluded: [], minWeight: 0n });
  assert.equal(result.claims.length, 0);
  assert.equal(result.total, 0n);
  assert.equal(result.remainder, 5_000n);
});

test('claim indices are contiguous and reproducible from the published set', () => {
  const first = distribute({ amount: 10_000n, holders, excluded: [], minWeight: 0n });
  const shuffled = [...holders].reverse();
  const second = distribute({ amount: 10_000n, holders: shuffled, excluded: [], minWeight: 0n });

  assert.equal(first.root, second.root, 'holder input order must not change the root');
  first.claims.forEach((claim, i) => assert.equal(claim.index, i));
});

test('a published distribution yields a verifiable proof per holder', () => {
  const result = distribute({ amount: 123_457n, holders, excluded: [], minWeight: 0n });
  for (const holder of holders) {
    const pkg = claimPackage(result, holder.owner);
    assert.ok(pkg, `${holder.owner} should have a claim`);
    assert.equal(verifyProof(pkg.claim, pkg.proof, result.root), true);
  }
  assert.equal(claimPackage(result, 'nobody'), null);
});

test('time-weighting rewards holding, not snapshot timing', () => {
  const weights = timeWeight(
    [
      // Held the whole epoch.
      { owner: 'diamond', balance: 100n, fromSlot: 0, toSlot: 1_000 },
      // Bought one slot before the snapshot.
      { owner: 'sniper', balance: 100n, fromSlot: 999, toSlot: 1_000 },
    ],
    1_000,
  );

  const byOwner = new Map(weights.map((w) => [w.owner, w.weight]));
  assert.equal(byOwner.get('diamond'), 100n);
  assert.equal(byOwner.get('sniper'), 0n);
});

test('multiple balance samples for one owner accumulate', () => {
  const weights = timeWeight(
    [
      { owner: 'alice', balance: 100n, fromSlot: 0, toSlot: 500 },
      { owner: 'alice', balance: 300n, fromSlot: 500, toSlot: 1_000 },
    ],
    1_000,
  );
  assert.equal(weights[0]?.weight, 200n);
});

test('negative distributions and impossible windows are refused', () => {
  assert.throws(() => distribute({ amount: -1n, holders, excluded: [], minWeight: 0n }), /negative/);
  assert.throws(
    () => timeWeight([{ owner: 'a', balance: 1n, fromSlot: 10, toSlot: 5 }], 100),
    /ends before it starts/,
  );
  assert.throws(() => timeWeight([], 0), /at least one slot/);
});
