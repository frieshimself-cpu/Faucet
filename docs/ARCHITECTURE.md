# Architecture

## The cycle

```
  Pons creator vault ─┐
                      ├─→ collect ─→ route ─→ distribute ─→ settle
  LP fee vault ───────┘      │         │          │           │
                             │         │          │           └─ intents (unsigned)
                             │         │          └─ Merkle root + claim file
                             │         └─ four buckets, exactly 100%
                             └─ finalized credits inside [fromSlot, toSlot)
```

Each stage is a separate module with a narrow job, and the boundaries are where
the safety properties live.

### `sources/` — observe only

A `FeeSource` reports what it saw. It holds no key and has no way to move money.
That is the point: an adapter bug can produce a wrong *number*, which the
conservation checks downstream will surface, but it can never produce a wrong
*transfer*.

`VaultFeeSource` reads the vault's balance delta per transaction rather than
parsing program logs. When Pons ships a new program version, a fee that lands in
the vault is still a fee, and the adapter keeps working.

### `router.ts` — split without leaking

Integer division loses remainders. "We lose three lamports an epoch" is exactly
the kind of quiet leak this project exists to not have, so allocation uses the
largest-remainder method: floor every bucket, then hand the leftover units out
one at a time to the buckets with the biggest fractional part.

`sum(allocations) === total` is guaranteed and asserted. Ties break on the
bucket's position in the config, so the same input produces the same allocation
on any machine, forever.

### `distributor.ts` — time-weighted, not snapshotted

Share of the drip is proportional to *balance integrated over the epoch*:

```
weight(owner) = Σ (balance_i × slots_held_i) / total_slots
```

A snapshot is trivially gamed — borrow a large balance, hold it across the
snapshot block, claim, repay. Integrating over the whole epoch makes that attack
cost the full epoch rather than one slot.

Anything the drip cannot divide evenly is returned as `remainder` and rolled into
the next epoch's collected total. It is never burned by rounding and never
quietly retained.

### `merkle.ts` — the parts that are easy to get wrong

Three details separate a working claim tree from an exploitable one, and each has
a test that fails without it:

1. **Domain separation.** Leaves hash with a `0x00` prefix, internal nodes with
   `0x01`. Without it, a 64-byte "leaf" can be replayed as an internal node and a
   proof forged for a claim that was never allocated.

2. **No self-pairing.** An odd node at a level is *promoted*, not paired with
   itself. Duplicating the last node lets one proof validate two different
   indices — a classic double-claim.

3. **Index inside the leaf.** `leaf = sha256(0x00 ‖ u32be(index) ‖ owner ‖ u64be(amount))`.
   A claim contract can mark index *n* spent in a bitmap and be certain no second
   leaf shares it.

Internal pairs are hashed in sorted order, so a proof is a flat list of sibling
hashes with no left/right bitmap for the verifier to get wrong.

The empty tree gets a distinct sentinel root (`sha256("faucet:empty")`, which
carries neither prefix and so can never collide with a real hash) and an empty
leaf level, so `proofFor` cannot hand out a proof for the sentinel itself.

### `engine.ts` — conservation

`assertConserved()` runs before any epoch is allowed to settle:

- routed total must equal collected total;
- drip claims plus remainder must equal the drip bucket;
- carry-out must equal the undistributed drip.

If any of those fail, the cycle throws instead of settling. A leak is a crash,
not a rounding footnote.

An epoch under `minSettleRaw` does not settle at all: spending 0.005 SOL in
transaction fees to move 0.002 SOL is a net loss, so the whole amount carries
forward and the receipt records it as carried rather than spent.

## Dependencies

The engine has **zero runtime dependencies**. It handles money, and every package
it pulls in is a package that can be hijacked and ship a postinstall script.
`SolanaRpc` is about a hundred lines of `fetch` over JSON-RPC with backoff; the
Merkle tree uses `node:crypto`. TypeScript and `@types/node` are the only
devDependencies.

## The site's relationship to the engine

The page is static. It reads `site/data/faucet.json`, which `faucet cycle
--write-site` writes, and `site/scripts/data.js`, which `npm run sync:fallback`
regenerates from that JSON for the `file://` case.

The percentages in the diagram, the gauges, the pressure-test allocator and the
ledger all come from that file. The pressure test even re-implements
largest-remainder allocation in `BigInt` so the numbers it shows are the numbers
the engine would settle — not a float approximation of them.

## What is deliberately not here yet

- **Signing.** `cycle` produces settlement intents; broadcasting them is a
  separate step so a bug in collection can never become a transfer.
- **A full holder index.** `--live` currently reads `getTokenLargestAccounts`,
  which caps at 20 accounts. That is a floor for testing, not the design; the
  roadmap item is a streamed balance index feeding the time-weighting.
- **On-chain policy.** The split is a committed file today. Moving it on-chain
  makes changing it cost a visible transaction instead of a commit.
