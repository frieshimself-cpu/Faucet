# Faucet

**Robinhood ($ROBIN) on Pons — every fee drips back into the project.**

Two things live in this repo:

| | |
|---|---|
| `engine/` | The fee-recycling engine. Collects fees, routes 100% of them into four buckets, builds a Merkle claim tree for the holder drip, and publishes an auditable receipt per epoch. |
| `site/` | The website. A static page with no backend, rendering the same policy and the same epoch data the engine settles with. |

The claim the site makes is enforced by code, not by copy: `assertPolicyBalanced()`
throws unless the routing policy allocates exactly 10,000 basis points, and
`assertConserved()` throws unless every lamport collected in an epoch either left
in a settlement intent or was explicitly carried into the next one.

---

## Quick start

```bash
npm install
npm test                 # typecheck + 38 tests
npm run policy           # print the split and prove it sums to 100%
npm run cycle            # settle 6 synthetic epochs and regenerate the site data
npm run serve            # http://localhost:4173
```

`npm run cycle` runs against deterministic mock fee sources, because the token has
not launched yet. The site labels its data accordingly — it says **synthetic** in
the ledger footer until a real mint address is configured.

---

## The split

| Bucket | Share | What happens to it |
|---|---|---|
| Buyback & Burn | 35.00% | Market-buys the token and burns what it buys. |
| Holder Drip | 35.00% | Split by time-weighted balance; claimed with a Merkle proof. |
| Liquidity Deepening | 20.00% | Added to the pool as protocol-owned liquidity. |
| Build Fund | 10.00% | On-chain treasury for tooling, audits, integrations. |

There is no team bucket and no outbound wallet that is not on that list. Network
transaction fees paid to validators to *make* those transfers are unavoidable and
come out of the build fund.

The split lives in exactly one place — [`engine/src/config.ts`](engine/src/config.ts) —
and the site renders a generated copy of it, so the page and the settlement can't
disagree.

---

## CLI

```
faucet policy                          show the routing policy
faucet cycle [--epochs N] [--seed N]   run epochs (mock sources unless --live)
         [--live] [--write-site] [--out DIR]
faucet verify <claims.json> <owner>    verify a published claim proof
faucet doctor                          sanity-check config and RPC
```

Verifying a drip needs nothing but the published claim file:

```
$ npm run faucet -- verify out/claims/epoch-3.json Hood042xxxxxxxxxxxxxxxxxxxxxxxxxxxx

  proof valid
  owner  Hood042xxxxxxxxxxxxxxxxxxxxxxxxxxxx
  index  42
  amount 0.0006 SOL
  proof  7 node(s)
  root   0x168163ee52ae9bf84eec35874632371dc0d0600fb5b4213b5dd6b42eb2500468
```

---

## Going live

1. Mint the token on Pons.
2. Fill in `CONFIG.mint.address` and `CONFIG.feeAccounts.*` in `engine/src/config.ts`.
3. Set `FAUCET_RPC_URL` (copy `.env.example` to `.env`).
4. `npm run doctor` — every check must pass.
5. `npm run build && node dist/src/cli.js cycle --live --write-site && npm run sync:fallback`

Settlement signing is deliberately *not* wired to a key in this build. `cycle`
computes and publishes settlement intents; broadcasting them is a separate,
explicit step. See [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Deploying

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffrieshimself-cpu%2FFaucet)

The repo is Vercel-ready as committed. `vercel.json` tells Vercel three things:

| Setting | Value | Why |
|---|---|---|
| `outputDirectory` | `site` | The site is a plain static directory. No bundler, no framework. |
| `buildCommand` | `npm run build && npm run policy` | Typechecks the engine and runs `faucet policy`, which throws unless the split sums to exactly 100%. **A deploy fails if the policy leaks a basis point.** |
| `headers` | CSP, `nosniff`, `DENY` framing, no-cache on data | The page has no inline scripts, so the CSP is strict. `data/faucet.json` is never cached, so a fresh cycle shows up immediately. |

Two ways to ship it:

**From the dashboard.** Click the button above, or import the repo at
[vercel.com/new](https://vercel.com/new). Vercel reads `vercel.json`; there is
nothing to configure. Every push to `main` deploys production; every other
branch gets a preview URL.

**From the CLI.**

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

`npm run serve` applies the same headers `vercel.json` declares, CSP included,
and serves `404.html` for missing routes — so anything that would break in
production breaks on `localhost:4173` first.

### Updating the numbers on a deployed site

```bash
npm run cycle       # regenerates site/data/faucet.json and the bundled fallback
git commit -am "epoch N"
git push            # Vercel redeploys
```

The page reads `data/faucet.json` on load and the header rules keep it
uncached, so the new epoch is live as soon as the deploy is.

### Any other static host

Point GitHub Pages (Settings → Pages → *Deploy from a branch*, folder `/site`),
Netlify, Cloudflare Pages, or an S3 bucket at the `site/` directory. Nothing in
it needs a server. Served over HTTP the page fetches `data/faucet.json`; opened
straight off disk it falls back to the snapshot baked into
`site/scripts/data.js`, which `npm run sync:fallback` regenerates. The footer
says which one you are looking at.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data flow, the
attack-resistance notes behind the Merkle implementation, and why the drip is
time-weighted rather than snapshotted.

---

## A word of caution

This is an experimental crypto project. There is no promise of value, liquidity or
return, and none of the mechanics here remove the risk of the token going to zero.
Nothing in this repository is financial advice or an offer of anything. Read the
code before you touch it.
