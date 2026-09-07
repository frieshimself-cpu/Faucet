import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG } from '../src/config.js';
import { assertConserved, runCycle } from '../src/engine.js';
import { MockFeeSource, syntheticReceipts } from '../src/sources/mock.js';
import type { FaucetConfig } from '../src/config.js';
import type { HolderWeight, SlotWindow } from '../src/types.js';

const WINDOW: SlotWindow = { fromSlot: 1_000, toSlot: 2_000 };

const HOLDERS: HolderWeight[] = [
  { owner: 'alice', weight: 5_000_000n },
  { owner: 'bob', weight: 3_000_000n },
  { owner: 'carol', weight: 2_000_000n },
];

function sourceWith(amounts: readonly bigint[]) {
  return new MockFeeSource({
    kind: 'pons-creator-fee',
    label: 'test',
    mint: CONFIG.native,
    receipts: amounts.map((amount, i) => ({
      signature: `sig-${i}`,
      slot: WINDOW.fromSlot + i,
      blockTime: 1_700_000_000,
      amount,
    })),
  });
}

test('a normal epoch conserves every lamport it collects', async () => {
  const result = await runCycle({
    config: CONFIG,
    epochId: 1,
    window: WINDOW,
    sources: [sourceWith([500_000_000n, 250_000_000n, 1n])],
    holders: HOLDERS,
  });

  assert.equal(result.settled, true);
  assert.equal(result.epoch.collected, 750_000_001n);
  assert.doesNotThrow(() => assertConserved(result.epoch));

  const routed = result.epoch.allocations.reduce((sum, a) => sum + a.amount, 0n);
  assert.equal(routed, result.epoch.collected);
});

test('an epoch below the settle floor is carried forward, not spent', async () => {
  const result = await runCycle({
    config: CONFIG,
    epochId: 1,
    window: WINDOW,
    sources: [sourceWith([1_000n])],
    holders: HOLDERS,
  });

  assert.equal(result.settled, false);
  assert.match(result.skipReason ?? '', /below the .* settle floor/);
  assert.equal(result.intents.length, 0);
  assert.equal(result.epoch.carryOut, 1_000n);
});

test('carry-in from a skipped epoch is collected by the next one', async () => {
  const skipped = await runCycle({
    config: CONFIG,
    epochId: 1,
    window: WINDOW,
    sources: [sourceWith([9_000_000n])],
    holders: HOLDERS,
  });
  assert.equal(skipped.settled, false);

  const next = await runCycle({
    config: CONFIG,
    epochId: 2,
    window: { fromSlot: 2_000, toSlot: 3_000 },
    sources: [
      new MockFeeSource({
        kind: 'lp-trading-fee',
        label: 'test',
        mint: CONFIG.native,
        receipts: [{ signature: 's', slot: 2_001, blockTime: null, amount: 500_000_000n }],
      }),
    ],
    holders: HOLDERS,
    carryIn: skipped.epoch.carryOut,
  });

  assert.equal(next.settled, true);
  assert.equal(next.epoch.collected, 509_000_000n);
  assert.equal(next.epoch.carryIn, 9_000_000n);
});

test('settlement intents cover every non-empty bucket', async () => {
  const result = await runCycle({
    config: CONFIG,
    epochId: 1,
    window: WINDOW,
    sources: [sourceWith([1_000_000_000n])],
    holders: HOLDERS,
  });

  const buckets = new Set(result.intents.map((i) => i.bucket));
  assert.deepEqual([...buckets].sort(), ['buyback', 'drip', 'liquidity', 'treasury']);
  assert.equal(result.intents.find((i) => i.bucket === 'buyback')?.action, 'buyback-and-burn');
  assert.equal(result.intents.find((i) => i.bucket === 'drip')?.action, 'fund-merkle');
});

test('the drip intent funds only what holders can actually claim', async () => {
  const result = await runCycle({
    config: CONFIG,
    epochId: 1,
    window: WINDOW,
    sources: [sourceWith([1_000_000_007n])],
    holders: HOLDERS,
  });

  const dripIntent = result.intents.find((i) => i.bucket === 'drip');
  assert.equal(dripIntent?.amount, result.epoch.distribution.total);
  // Anything the tree could not divide stays with the protocol for next epoch.
  assert.equal(result.epoch.carryOut, result.epoch.distribution.remainder);
});

test('a leak in the epoch is caught by the conservation check', () => {
  const broken = {
    id: 9,
    window: WINDOW,
    openedAt: '', closedAt: '',
    collected: 1_000n,
    collections: [],
    allocations: [{ bucket: 'drip' as const, bps: 10_000, amount: 900n, destination: null }],
    distribution: { root: '0x0', claims: [], total: 0n, remainder: 900n },
    carryIn: 0n,
    carryOut: 900n,
  };
  assert.throws(() => assertConserved(broken), /routed 900 but collected 1000/);
});

test('an empty slot window is a programming error, not an empty epoch', async () => {
  await assert.rejects(
    runCycle({
      config: CONFIG,
      epochId: 1,
      window: { fromSlot: 500, toSlot: 500 },
      sources: [],
      holders: HOLDERS,
    }),
    /empty window/,
  );
});

test('a full synthetic run over many epochs never leaks', async () => {
  let carry = 0n;
  const config: FaucetConfig = CONFIG;

  for (let i = 0; i < 12; i++) {
    const window: SlotWindow = { fromSlot: i * 1_000, toSlot: (i + 1) * 1_000 };
    const result = await runCycle({
      config,
      epochId: i + 1,
      window,
      sources: [
        new MockFeeSource({
          kind: 'lp-trading-fee',
          label: 'synthetic',
          mint: config.native,
          receipts: syntheticReceipts(i + 1, 30, window),
        }),
      ],
      holders: HOLDERS,
      carryIn: carry,
    });

    if (result.settled) assert.doesNotThrow(() => assertConserved(result.epoch));
    carry = result.epoch.carryOut;
  }
});
