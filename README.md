# Faucet

**Robinhood ($ROBIN) on Pons, Robinhood Chain — every creator reward buys the coin back and burns it.**

| | |
|---|---|
| `engine/` | The buyback-and-burn engine. Reads the dev wallet, keeps a gas reserve, swaps the rest for the token with the router's recipient set to the burn address, and refuses to record a cycle unless every wei is accounted for. |
| `site/` | The website. Static, no backend: the ledger the engine wrote, a burn log with per-cycle detail, a transaction lookup, docs, and a changelog. Every page carries the commit it was built from. |

Two invariants are enforced in code, not copy. `assertPolicyBalanced()` throws
unless the routing policy allocates exactly 10,000 basis points, and runs on
import. After every swap the engine checks `balance_before − spent − gas ==
balance_after`, to the wei, and will not record the cycle otherwise.

---

## Quick start

```bash
npm install
npm test                 # typecheck + 17 tests against an in-memory chain
npm run policy           # print the one rule and prove it sums to 100%
npm run cycle            # 6 mock burn cycles; regenerates the site data
npm run serve            # http://localhost:4173
```

`npm run cycle` runs against the mock chain because the token has not launched.
The site labels every number that comes from it as synthetic.

---

## What one cycle does

```
Pons creator rewards (ETH) ─→ dev wallet
                                 ├─ keep the gas reserve            0.002 ETH
                                 └─ spend the rest ─→ router.swapExactETHForTokensSupportingFeeOnTransferTokens(
                                                        amountOutMin = quote × (1 − 3%),
                                                        path = [WETH, ROBIN],
                                                        to   = 0x000000000000000000000000000000000000dEaD )
                                                      ─→ read Transfer(ROBIN → 0x…dEaD) from the receipt
                                                      ─→ balance check, to the wei
                                                      ─→ ledger entry (site/data/burns.json)
```

The recipient of the swap is the burn address, so the tokens go from the pool to
0x…dEaD inside the same transaction and never sit in a wallet anyone controls.

| Limit | Default | Why |
|---|---|---|
| Gas reserve | 0.002 ETH | Left behind so the next cycle can always pay for gas. |
| Minimum buyback | 0.005 ETH | Below this nothing is bought; a tiny swap is mostly gas. |
| Slippage bound | 3% | `amountOutMin` from a fresh quote; the router reverts below it. |
| Deadline | 180 s | A signed swap not mined in time is void. |

---

## CLI

```
faucet policy                       show the routing policy
faucet plan [--mock]                read the wallet and quote the buyback (no spend)
faucet burn [--execute] [--mock]    run a cycle; --execute sends the swap
            [--rounds N] [--write-site]
faucet status                       totals from the burn ledger
faucet verify <txhash>              confirm a tx burned the token
faucet doctor                       check config, RPC and signer
```

`--execute` is the only flag that spends anything, and only with a signer that
matches the configured dev wallet.

---

## Going live

1. Copy `.env.example` to `.env`. Fill in the Robinhood Chain RPC, chain id and
   explorer prefix, the router and WETH, the token, and the dev wallet. These are
   deliberately not in the repository until confirmed against the launch docs.
2. `npm run doctor` — every check must pass. It pins the chain id, reads the
   wallet and the token supply, and gets a quote from the router.
3. `npm run plan` — see what one cycle would do, with nothing sent.
4. Export `FAUCET_DEV_WALLET_KEY` in the shell (never in a file), then
   `node dist/src/cli.js burn --execute --write-site`.
5. Commit and push the ledger; the site redeploys with the burn.

The engine will not send if the signer is not the configured wallet, if the
swap recipient is not the burn address, or if the plan does not account for the
whole balance. See [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Deploying

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffrieshimself-cpu%2FFaucet)

`vercel.json` serves `site/` and uses the build step as a guard: it typechecks
the engine and runs `faucet policy`, which throws unless the policy sums to
100%. Headers include a strict Content-Security-Policy (no inline scripts) and
`data/` is served uncached so a fresh burn shows on the next load.

```bash
npm i -g vercel
vercel --prod
```

`npm run serve` applies the same headers locally, CSP included.

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## A word of caution

This is an experimental crypto project. There is no promise of value, liquidity or
return, and a buyback does not remove the risk of the token going to zero.
Nothing in this repository is financial advice. Read the code before you touch it.
