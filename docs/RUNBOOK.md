# Runbook

## Before the first live cycle

```bash
export FAUCET_TOKEN=0x...          # the token, as launched on Pons
export FAUCET_DEV_WALLET=0x...     # the wallet that launched it
npm install && npm test            # must be green
npm run doctor                     # every line must be ok
npm run plan                       # what one cycle would do; nothing is sent
```

`doctor` checks the RPC reports chain id 4663, the gas price against the
reserve, the token contract, the factory's launch record (a Pons v2 launch,
paired with ETH, its phase, and that the creator fee recipient is the dev
wallet), the claimable balance in the fee escrow, and finally simulates a buy of
0.001 ETH to the burn address on whichever venue the token trades on now and
compares it with the quote. With `FAUCET_DEV_WALLET_KEY` set it also confirms the
key is the dev wallet.

## What the engine will and will not spend

The first tick records the wallet balance as the untouched baseline and sends
nothing. From then on only claimed rewards are spent, gas included. `faucet
baseline` shows the baseline, the wallet, and the claimed pool. If you top the
wallet up for gas, that ETH is not spent either; `faucet baseline --set` folds
anything above the ledger's claimed pool into the untouched amount.

## Running a cycle by hand

```bash
export FAUCET_DEV_WALLET_KEY=...        # in the shell, never in a file
node dist/src/cli.js burn --execute --write-site
npm run sync:fallback && npm run build:info
git commit -am "burn N" && git push     # the site redeploys with the burn
```

Read the receipts before you move on:

- **claim / received** — what came out of the escrow. It must equal what
  `balanceOf` said.
- **spent** — ETH sent as the buy's value.
- **burned** — tokens that reached the burn address, from the receipt, with the
  quote and realised slippage beside it.
- **wallet** — balance before and after.
- **conserved** — the wei check. It must say yes.

## Running every 3 minutes

```bash
export FAUCET_TOKEN=0x... FAUCET_DEV_WALLET=0x... FAUCET_DEV_WALLET_KEY=...
npm run run:live        # node dist/src/cli.js run --every 180 --commit-every 30
```

The runner loops: claim, plan, execute, record, sleep 180 s. Nothing to claim
and nothing above the floor means nothing happens that tick. A lock file
(`.faucet.lock`) prevents two runners overlapping; a stale lock from a crashed
runner is reclaimed. Failures back off, doubling to a ten-minute cap, and reset
on the next good tick. With `--commit-every 30`, at most twice an hour the
runner commits `site/data` and pushes, and the site redeploys with the new
burns. Use `deploy/faucet.service` or the Dockerfile to keep it running; the
key lives only in that process's environment.

## When nothing happens

```
skip   spendable claimed rewards 0 wei are under the 2000000000000000 wei floor
```

Normal on a quiet cycle: nothing was claimable, or what is in the wallet is
under the floor. The rewards wait for the next one.

## When a buy is refused

```
FAIL   buy rejected before sending: execution reverted (bonding curve: output below minOut). Nothing was signed and no gas was spent
```

The market moved more than 3% between quote and fill and the node refused the
buy before it was signed. The ETH is still in the wallet; the next tick quotes
again. Do not loosen the bound to force it through. If it repeats, the market
is too thin for the size; lower `FAUCET_MIN_BUYBACK_WEI` is not the fix, more
frequent smaller claims are.

## When a claim is refused

```
claim rejected before sending: execution reverted (fee escrow: nothing to claim)
```

The escrow balance went to zero between the read and the send. Harmless; the
next tick reads again.

## When the route is missing

```
skip   no route: token graduated but its Uniswap v4 pool has no liquidity yet
```

The token just graduated and the pool is being seeded. The engine waits; the
claimed ETH stays in the wallet.

## When conservation fails

```
FAIL   wallet balance after buy 0x… is …, expected …
```

The cycle is not recorded. Something else moved ETH in the wallet between the
plan and the receipt. The receipt's numbers will show what; do not send again
until it is explained.

## Resetting the ledger

```bash
npm run reset      # empties site/data/burns.json and faucet.json, regenerates the fallback
```

Only for a fresh start before launch. Live receipts are the record; do not
reset a ledger with live burns in it.

## Changing the limits

Set `FAUCET_GAS_RESERVE_WEI`, `FAUCET_MIN_BUYBACK_WEI` or `FAUCET_MIN_CLAIM_WEI`
in the runner's environment, or edit `limits` in `engine/src/config.ts`.
Changing the routing policy is the same file; the engine refuses to import a
policy that does not sum to 10,000 bps.
