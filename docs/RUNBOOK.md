# Runbook

## Before the first live cycle

```bash
cp .env.example .env      # fill every value from the launch docs
npm install
npm test                  # must be green
npm run doctor            # every check must pass
npm run plan              # what one cycle would do; nothing is sent
```

`doctor` fails until every chain and contract setting is present. It then
checks the RPC reports the pinned chain id, reads the dev wallet balance and
the token's total supply, and asks the router for a quote.

## Running a cycle

```bash
export FAUCET_DEV_WALLET_KEY=...        # in the shell, never in a file
npm run build
node dist/src/cli.js burn --execute --write-site
npm run sync:fallback && npm run build:info
git commit -am "burn N" && git push     # the site redeploys with the burn
```

Read the receipt before you move on:

- **spent** — ETH sent as the swap value.
- **burned** — tokens that reached the burn address, from the receipt, with the
  quote and realised slippage beside it.
- **wallet** — balance before and after.
- **conserved** — the wei check. It must say yes.

## When nothing is bought

```
NOT SETTLED  spendable 0.0031 ETH is under the 0.005 ETH floor
```

Normal on a quiet cycle. The balance waits for the next one.

## When a swap reverts

```
error swap 0x… reverted (slippage over 300 bps, or the deadline passed). Only gas was spent.
```

The ETH is still in the wallet. Do not loosen the bound to force it through.
Run `plan` again and see whether the pool has settled. If reverts repeat at 3%
the pool is too thin for the size; run smaller, more frequent cycles.

## When conservation fails

```
error wallet balance after swap is …, expected …
```

The cycle is not recorded. Something else moved ETH in the wallet between the
plan and the receipt. The receipt's numbers will show what; do not send again
until it is explained.

## Scheduling

A cycle that finds nothing above the floor does nothing, so running on a timer
is safe. Hourly is a sensible starting cadence once rewards flow. Whatever runs
it must have `FAUCET_DEV_WALLET_KEY` in its environment and nowhere else.

## Changing the limits

Edit `limits` in `engine/src/config.ts`, then `npm run cycle` so the page
matches. Changing the routing policy is the same file; the engine refuses to
import a policy that does not sum to 10,000 bps.
