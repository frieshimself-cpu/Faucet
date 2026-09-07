/**
 * A deterministic in-memory fee source.
 *
 * Used by the test suite and by `cycle --dry-run` before the mint exists, so the
 * whole pipeline — collect, route, distribute, report — can be exercised end to
 * end without touching a network or a key.
 */

import type { CollectionResult, FeeReceipt, FeeSource, FeeSourceKind, Mint, SlotWindow } from '../types.js';

export interface MockSourceOptions {
  readonly kind: FeeSourceKind;
  readonly label: string;
  readonly mint: Mint;
  /** Receipts to serve; only those inside the requested window are returned. */
  readonly receipts: readonly Omit<FeeReceipt, 'source' | 'mint'>[];
}

export class MockFeeSource implements FeeSource {
  readonly kind: FeeSourceKind;
  readonly label: string;
  readonly #options: MockSourceOptions;

  constructor(options: MockSourceOptions) {
    this.kind = options.kind;
    this.label = options.label;
    this.#options = options;
  }

  async collect(window: SlotWindow): Promise<CollectionResult> {
    const receipts: FeeReceipt[] = this.#options.receipts
      .filter((r) => r.slot >= window.fromSlot && r.slot < window.toSlot)
      .map((r) => ({ ...r, source: this.kind, mint: this.#options.mint }));

    return {
      source: this.kind,
      window,
      receipts,
      total: receipts.reduce((sum, r) => sum + r.amount, 0n),
    };
  }
}

/** Builds a repeatable pseudo-random epoch of fees from a seed. No Math.random. */
export function syntheticReceipts(
  seed: number,
  count: number,
  window: SlotWindow,
): Array<Omit<FeeReceipt, 'source' | 'mint'>> {
  let state = seed >>> 0;
  const next = (): number => {
    // xorshift32 — small, deterministic, and good enough for fixtures.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffff_ffff;
  };

  const span = Math.max(1, window.toSlot - window.fromSlot);

  return Array.from({ length: count }, (_, i) => {
    const slot = window.fromSlot + Math.floor(next() * span);
    return {
      signature: `mock${seed}-${i}`.padEnd(16, '0'),
      slot,
      blockTime: 1_700_000_000 + slot,
      amount: BigInt(Math.floor(next() * 4_000_000) + 50_000),
    };
  }).sort((a, b) => a.slot - b.slot);
}
