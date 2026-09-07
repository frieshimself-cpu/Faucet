# Runbook

## Before the first live cycle

```bash
cp .env.example .env      # set FAUCET_RPC_URL
npm install
npm test                  # must be green
npm run doctor            # every check must pass
```

`doctor` fails until `CONFIG.mint.address` and at least one entry in
`CONFIG.feeAccounts` are set. That is intentional — a live cycle against an
unconfigured engine would silently collect nothing and settle nothing.

## Running an epoch

```bash
npm run build
node dist/src/cli.js cycle --live --write-site
npm run sync:fallback
```

Read the printed receipt before you act on it:

- **collected** — total in, including anything carried from the last epoch.
- **routing** — the four buckets. These must sum to collected; the engine
  refuses to print otherwise.
- **drip** — recipient count, distributed amount, carry-out, Merkle root.
- **settlement** — the intents. Nothing has been broadcast.

## Publishing a drip

1. Publish `out/claims/epoch-N.json` wherever holders can fetch it.
2. Fund the claim account with the amount in the `fund-merkle` intent — that is
   `distribution.total`, not the whole drip bucket. The difference is the dust
   that could not be divided, and it belongs to the next epoch.
3. Anyone can now check their own drip:
   ```bash
   node dist/src/cli.js verify out/claims/epoch-N.json <owner>
   ```

## When an epoch does not settle

```
  NOT SETTLED  collected 4210000 is below the 10000000 settle floor; carried forward
```

This is normal on a quiet epoch. Nothing was spent, `carryOut` holds the full
amount, and the next cycle picks it up via `carryIn`. Do not lower
`minSettleRaw` to force a settlement — the floor exists because the transaction
fees would exceed the transfer.

## When conservation fails

```
  error epoch 4: routed 900 but collected 1000
```

The engine caught a leak and refused to settle. Nothing was broadcast. Do not
retry — capture the epoch's inputs and find the bug. `assertConserved` failing is
always an engine defect, never a transient condition.

## Changing the split

Edit `ROUTING` in `engine/src/config.ts`. The basis points must still sum to
10,000 or `assertPolicyBalanced` throws on import and nothing runs at all.

Then regenerate the site data so the page matches what will settle:

```bash
npm run cycle
```

Changing the split is a visible commit that changes both the engine and the
published page in the same diff. That is the current guarantee; the roadmap item
is to move the policy on-chain so it costs a transaction instead.

## Rotating the RPC endpoint

`FAUCET_RPC_URL` only. The client retries 429s and 5xx with exponential backoff
and gives up after five attempts rather than hammering a rate-limited endpoint.
Public endpoints will rate-limit a full epoch scan; use an authenticated provider
for live runs.
