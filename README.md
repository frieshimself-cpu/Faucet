# Faucet

**Robinhood ($ROBIN) on Pons, Robinhood Chain — every three minutes, every creator reward buys the coin back and burns it.**

| | |
|---|---|
| `engine/` | The buyback-and-burn engine. Claims the creator rewards Pons holds for the dev wallet, keeps a gas reserve, spends the rest buying the token with the buy's recipient set to the burn address, and refuses to record a cycle unless every wei is accounted for. |
| `site/` | The website. Static, no backend: the ledger the engine wrote, a burn log with per-cycle detail, a transaction lookup, docs, and a changelog. Every page carries the commit it was built from. |

Two invariants are enforced in code, not copy. `assertPolicyBalanced()` throws
unless the routing policy allocates exactly 10,000 basis points, and runs on
import. After every buy the engine checks `balance_before − spent − gas ==
balance_after`, to the wei, and will not record the cycle otherwise.

---

## Quick start

```bash
npm install
npm test                 # typecheck + unit tests + an integration test that deploys a real
                         # ERC-20, a Pons-shaped bonding curve and fee escrow to a local EVM
                         # node and runs the live code path (ethers, real signing) against it
npm run policy           # print the one rule and prove it sums to 100%
npm run demo             # 6 mock cycles into .faucet-mock/ (never into site/data)
npm run serve            # http://localhost:4173
```

The shipped ledger is empty. It fills only with real Robinhood Chain
transactions; mock runs write elsewhere.

---

## What one cycle does

```
Pons fee escrow ── claim() ──→ dev wallet
  balanceOf(dev wallet)           ├─ keep the gas reserve                          0.001 ETH
  accrues on every trade          └─ spend the rest ──→ buy, recipient = 0x…dEaD
                                                          before graduation:  curve.buy(amountIn, minOut, 0x…dEaD) {value}
                                                          after graduation:   UniversalRouter.execute(V4_SWAP: swap → settle → take(0x…dEaD))
                                                        ──→ read Transfer(ROBIN → 0x…dEaD) from the receipt
                                                        ──→ balance check, to the wei
                                                        ──→ ledger entry (site/data/burns.json)
```

The recipient of the buy is the burn address, so the tokens go from the market
to 0x…dEaD inside the same transaction and never sit in a wallet anyone controls.

**Only claimed rewards are spent.** On its first cycle the engine records the
wallet's balance as an untouched baseline. After that it spends only the pool
of claimed rewards, measured both as the wallet above that baseline and as the
ledger's claims net of buys and gas, taking the smaller. Gas comes from the
pool too. ETH that was already in the wallet, or arrives from anywhere other
than a claim, is never spent. `faucet baseline` shows the numbers.

| Limit | Default | Why |
|---|---|---|
| Cycle | 180 s | Claim, then buy and burn. A quiet cycle does nothing. |
| Minimum claim | 0.0005 ETH | Below this the rewards stay in the escrow for a later cycle. |
| Gas reserve | 0.001 ETH | Left behind so the next cycle can always pay for gas. |
| Minimum buyback | 0.002 ETH | Below this nothing is bought; a tiny buy is mostly gas. |
| Slippage bound | 3% | `minOut` from a fresh quote; the market reverts below it. |
| Deadline | 180 s | A signed buy not mined in time is void. |

---

## Verified against Robinhood Chain

Every address and call the engine makes was checked against mainnet (chain id
4663) by simulation before it was written down, with no key involved:

- **Fee escrow** `0xd3AF…Ac9e`: `balanceOf(creator)` is the claimable ETH;
  `claim()` pays exactly that to the caller and reverts when it is zero.
- **Factory** `0x7eD5…C97e`: `getLaunchedToken(token)` gives the curve, the
  creator fee recipient, the pair token and the v4 tick spacing.
- **Bonding curve**: `buy(amountIn, minOut, recipient)` is payable, delivers the
  tokens to `recipient`, returns the amount, and reverts under `minOut`.
- **Uniswap v4**: the pool key `{ETH, token, fee 0, tick spacing, Pons hook}`
  reproduces the PoolManager's pool id; the V4 quoter's answer matched the
  Universal Router's fill to the unit; `TAKE` to the burn address works.

`faucet doctor` repeats the relevant checks for the configured token, including
a simulated buy to the burn address, so nothing is sent until they pass.

---

## CLI

```
faucet policy                       show the routing policy
faucet baseline [--set]             show (or record) the wallet balance that is never spent
faucet claim [--execute] [--mock]   claim creator rewards from the Pons fee escrow
faucet plan [--mock]                read the wallet and quote the buyback (no spend)
faucet burn [--execute] [--mock]    one cycle: claim, buy, burn; --execute sends
            [--rounds N] [--write-site]
faucet run [--every S] [--mock]     cycle forever (default every 180s)
           [--commit-every M]       commit + push the ledger at most every M minutes
faucet status                       totals from the burn ledger
faucet verify <txhash>              confirm a tx burned the token
faucet doctor                       check config, RPC, launch record; simulate a buy
faucet reset --yes                  empty the ledger and the site data
```

## Running every 3 minutes

```bash
export FAUCET_TOKEN=0x...                  # the token, as launched on Pons
export FAUCET_DEV_WALLET=0x...             # the wallet that launched it
export FAUCET_DEV_WALLET_KEY=...           # in the shell or a secret store, never a file in the repo
npm run doctor                             # every line must be ok
npm run run:live                           # = node dist/src/cli.js run --every 180 --commit-every 30
```

`run` is a loop: claim, plan, execute, record, sleep. A tick that finds nothing
to claim and nothing above the floor does nothing, so a short interval is safe.
A lock file stops two runners from overlapping. A failed tick backs off
(doubling, capped at ten minutes) and the next tick quotes fresh rather than
retrying blind. With `--commit-every`, the runner commits `site/data` and pushes
when the ledger has changed, which is what makes a Vercel-hosted site redeploy
with the burn.

Two ways to keep it up:

- **Docker:** `docker build -t faucet-runner . && docker run --env-file .env -e FAUCET_DEV_WALLET_KEY=… faucet-runner`
- **systemd:** `deploy/faucet.service`, with the key in `/etc/faucet.env` (mode 0600).

Serverless cron is the wrong shape for this: the signer needs a long-lived
process with the key in memory.

The engine will not send if the signer is not the configured wallet, if the
buy recipient is not the burn address, or if the plan does not account for the
whole balance. See [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Deploying the site

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
