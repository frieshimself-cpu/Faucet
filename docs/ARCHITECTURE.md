# Architecture

## The cycle

```
Pons fee escrow ─ claim ─→ dev wallet ─→ plan ─→ execute ─→ ledger
                                          │        │
                                          │        ├─ curve.buy(amountIn, minOut, burn) {value}          (before graduation)
                                          │        ├─ UniversalRouter.execute(V4_SWAP → take(burn))      (after graduation)
                                          │        ├─ receipt: sum Transfer(token → burn)
                                          │        └─ balance check, to the wei
                                          └─ balance − reserve → routing policy → launch record → route → quote → minOut
```

`claimRewards` (engine/src/buyback.ts) reads `feeEscrow.balanceOf(wallet)`,
skips if it is zero or under the minimum, otherwise sends `claim()` and checks
the wallet received exactly that amount less gas. `plan` is pure with respect
to money: it reads and computes, nothing is signed. `execute` takes a plan and
sends exactly that, then verifies the wallet moved by exactly `spend + gas`. A
dry run and a live run compute the same plan; the only difference is whether
`execute` is called.

## Routing

A Pons v2 launch trades on its bonding curve until it graduates, then on a
Uniswap v4 pool whose key is `{ETH, token, fee 0, tick spacing from the launch
record, the Pons hook}`. Each cycle `plan` reads the factory's launch record and
the curve's `graduated()` flag, and picks the venue (`routeFor`). It refuses to
buy if the token is not a Pons v2 launch, is not paired with ETH, or has
graduated into a pool with no liquidity yet.

Both venues take the burn address as the recipient of the buy. On the curve it
is the third argument of `buy`. On v4 it is the `TAKE` action's recipient with
amount `OPEN_DELTA`, so the router hands the whole output to 0x…dEaD.

## The chain boundary

Everything the engine needs from the chain fits in one interface (`Chain` in
engine/src/evm.ts): balance, block, token supply and balance, the launch
record, the claimable balance, send a claim, quote a route, send a buy, read a
receipt. Two implementations:

- `EthersChain` — ethers v6 over JSON-RPC, with the chain id pinned so ethers
  refuses to talk to the wrong network. The engine's one runtime dependency.
  The curve is quoted by simulating `buy` with `eth_call` (there is no separate
  quote function; the simulation is the exact answer). v4 is quoted through the
  V4 quoter. A buy that would fall under `minOut` is refused by the node's
  gas estimate before anything is signed, so it costs nothing.
- `MockChain` — in memory, deterministic: an escrow that accrues, a market with
  constant-product-style impact, configurable execution drift so slippage
  protection can be exercised, and a revert path that spends gas and nothing
  else. Used by the tests and mock runs.

`engine/src/pons.ts` holds the addresses, ABIs and calldata encoders, each
annotated with how it was verified against Robinhood Chain mainnet.

## Conservation

Before a cycle is recorded:

```
balance_before − eth_spent − gas_cost == balance_after   (wei)
tokens_burned ≥ amountOutMin
gas_cost ≤ gas_reserve
claimed == feeEscrow.balanceOf(wallet) before the claim
```

The ledger loader re-checks the first line on every receipt it reads, so a
hand-edited ledger is rejected too. `assertPolicyBalanced` runs on import and
throws unless the policy sums to 10,000 bps.

## Configuration

Limits are literals in `engine/src/config.ts`, overridable in wei from the
environment. Chain and venue addresses default to Robinhood Chain and the Pons
v2 contracts and can be overridden. The two launch-specific values, the token
and the dev wallet, must come from the environment. `faucet doctor` checks the
launch record's creator fee recipient is the dev wallet, because that is the
address the escrow credits; a mismatch means the engine could never claim.

## The runner

`engine/src/runner.ts` loops claim → plan → execute every N seconds (180 by
default), with a lock file, exponential backoff on failure, and an optional
commit-and-push of `site/data` so a Vercel-hosted site redeploys with each
burn. Mock runs write under `.faucet-mock/`, never into `site/data`.
