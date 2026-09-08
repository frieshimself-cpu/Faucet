# Architecture

## The cycle

```
Pons creator rewards (ETH) ─→ dev wallet ─→ plan ─→ execute ─→ ledger
                                              │        │
                                              │        ├─ swapExactETHForTokens…(minOut, [WETH, token], burn, deadline)
                                              │        ├─ receipt: sum Transfer(token → burn)
                                              │        └─ balance check, to the wei
                                              └─ balance − reserve → routing policy → quote → minOut
```

`plan` (engine/src/buyback.ts) is pure with respect to money: it reads and
computes, nothing is signed. `execute` takes a plan and sends exactly that,
then verifies the wallet moved by exactly `spend + gas`. A dry run and a live
run compute the same plan; the only difference is whether `execute` is called.

## The chain boundary

Everything the engine needs from the chain fits in one small interface
(`Chain` in engine/src/evm.ts): balance, block number, quote, token supply and
balance, send a swap, read a receipt. Two implementations:

- `EthersChain` — ethers v6 over JSON-RPC, with the chain id pinned so ethers
  refuses to talk to the wrong network. The engine's one runtime dependency;
  hand-rolling secp256k1 for code that moves money would be the wrong kind of
  clever.
- `MockChain` — in memory, deterministic. Constant-product-style price impact,
  configurable execution drift so slippage protection can be exercised, and a
  revert path that spends gas and nothing else. Used by the tests and by the
  pre-launch site data.

## Why the swap recipient is the burn address

If tokens landed in the dev wallet first there would be a moment where they
could go somewhere else. Setting the router's `to` to `0x…dEaD` removes that
moment: the buy and the burn are one atomic transaction, and the receipt's
`Transfer` log to the burn address is what the ledger records as burned. The
quote is recorded beside it so realised slippage is visible.

## Conservation

Before a cycle is recorded:

```
balance_before − eth_spent − gas_cost == balance_after   (wei)
tokens_burned ≥ amountOutMin
gas_cost ≤ gas_reserve
```

The ledger loader re-checks the first line on every receipt it reads, so a
hand-edited ledger is rejected too. `assertPolicyBalanced` runs on import and
throws unless the policy sums to 10,000 bps.

## Configuration

Limits are literals in `engine/src/config.ts`. Chain and contract addresses
come from the environment and are left unset in the repository until confirmed
against the Robinhood Chain and Pons launch documentation; nothing is guessed.
`faucet doctor` refuses live mode until every one is set and the RPC reports
the pinned chain id.

## What is deliberately not here

- **A scheduler.** One cycle per invocation. Cron or a small runner is a
  separate concern.
- **Claiming from Pons.** If rewards require an explicit claim rather than being
  paid to the wallet, a source step belongs before `plan`.
- **Any address literal.** Not the router, not WETH, not the token.
