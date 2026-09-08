/* ═══════════════════════════════════════════════════════════════════════════
   data.js — the last-known-good dataset, baked in at build time.

   The page prefers the live file at `data/faucet.json`, which the engine
   rewrites on every cycle. This copy exists so the site still renders real
   numbers when it is opened straight off disk (file:// blocks fetch) or when
   the JSON has not been regenerated yet. Never hand-edit it: regenerate with
   `npm run sync:fallback`.
   ═══════════════════════════════════════════════════════════════════════════ */

window.FAUCET_FALLBACK = {
  "generatedAt": "2026-09-08T04:00:13.978Z",
  "mode": "mock",
  "project": {
    "name": "Robinhood",
    "ticker": "ROBIN",
    "tagline": "Every creator reward buys the coin back and burns it.",
    "launchpad": "Pons",
    "chain": "Robinhood Chain"
  },
  "chain": {
    "chainId": null,
    "explorerTx": null
  },
  "token": {
    "address": null,
    "symbol": "ROBIN",
    "decimals": 18
  },
  "native": {
    "address": null,
    "symbol": "ETH",
    "decimals": 18
  },
  "devWallet": null,
  "burnAddress": "0x000000000000000000000000000000000000dEaD",
  "policy": [
    {
      "bucket": "buyback",
      "label": "Buyback & burn",
      "bps": 10000,
      "intent": "Every creator reward the dev wallet receives is swapped for the token on the DEX, with the swap output sent directly to the burn address."
    }
  ],
  "limits": {
    "gasReserve": "0.002",
    "minBuyback": "0.005",
    "slippageBps": 300,
    "deadlineSeconds": 180
  },
  "totals": {
    "burns": 6,
    "ethSpentRaw": "208670786995224376",
    "ethSpent": "0.2086",
    "tokensBurnedRaw": "8718133718325092409467",
    "tokensBurned": "8,718.13",
    "gasRaw": "96000000000000",
    "gas": "0.000096",
    "supplyRaw": "1000000000000000000000000000",
    "supplyBurnedPct": "0.0008%",
    "lastBurnAt": "2025-10-20T22:40:06.000Z"
  },
  "burns": [
    {
      "id": 1,
      "txHash": "0x0000000000000000000000000000000000000000000000000000000000000001",
      "block": 1000001,
      "timestamp": "2025-10-20T22:40:01.000Z",
      "mode": "mock",
      "ethSpentRaw": "36711197394577600",
      "ethSpent": "0.0367",
      "tokensBurnedRaw": "1534011484740700459282",
      "tokensBurned": "1,534.01",
      "expectedOut": "1,540.17",
      "minOut": "1,493.96",
      "slippageRealisedBps": 40,
      "gas": "0.000016",
      "explorerUrl": null
    },
    {
      "id": 2,
      "txHash": "0x0000000000000000000000000000000000000000000000000000000000000002",
      "block": 1000002,
      "timestamp": "2025-10-20T22:40:02.000Z",
      "mode": "mock",
      "ethSpentRaw": "13618284272239144",
      "ethSpent": "0.0136",
      "tokensBurnedRaw": "569447325723132539968",
      "tokensBurned": "569.44",
      "expectedOut": "571.73",
      "minOut": "554.58",
      "slippageRealisedBps": 40,
      "gas": "0.000016",
      "explorerUrl": null
    },
    {
      "id": 3,
      "txHash": "0x0000000000000000000000000000000000000000000000000000000000000003",
      "block": 1000003,
      "timestamp": "2025-10-20T22:40:03.000Z",
      "mode": "mock",
      "ethSpentRaw": "52480437158551168",
      "ethSpent": "0.0524",
      "tokensBurnedRaw": "2191905241047501272950",
      "tokensBurned": "2,191.9",
      "expectedOut": "2,200.7",
      "minOut": "2,134.68",
      "slippageRealisedBps": 40,
      "gas": "0.000016",
      "explorerUrl": null
    },
    {
      "id": 4,
      "txHash": "0x0000000000000000000000000000000000000000000000000000000000000004",
      "block": 1000004,
      "timestamp": "2025-10-20T22:40:04.000Z",
      "mode": "mock",
      "ethSpentRaw": "16024770093919888",
      "ethSpent": "0.016",
      "tokensBurnedRaw": "670025917303600465869",
      "tokensBurned": "670.02",
      "expectedOut": "672.71",
      "minOut": "652.53",
      "slippageRealisedBps": 40,
      "gas": "0.000016",
      "explorerUrl": null
    },
    {
      "id": 5,
      "txHash": "0x0000000000000000000000000000000000000000000000000000000000000005",
      "block": 1000005,
      "timestamp": "2025-10-20T22:40:05.000Z",
      "mode": "mock",
      "ethSpentRaw": "35645303623500584",
      "ethSpent": "0.0356",
      "tokensBurnedRaw": "1489519804475416758802",
      "tokensBurned": "1,489.51",
      "expectedOut": "1,495.5",
      "minOut": "1,450.63",
      "slippageRealisedBps": 40,
      "gas": "0.000016",
      "explorerUrl": null
    },
    {
      "id": 6,
      "txHash": "0x0000000000000000000000000000000000000000000000000000000000000006",
      "block": 1000006,
      "timestamp": "2025-10-20T22:40:06.000Z",
      "mode": "mock",
      "ethSpentRaw": "54190794452435992",
      "ethSpent": "0.0541",
      "tokensBurnedRaw": "2263223945034740912596",
      "tokensBurned": "2,263.22",
      "expectedOut": "2,272.31",
      "minOut": "2,204.14",
      "slippageRealisedBps": 40,
      "gas": "0.000016",
      "explorerUrl": null
    }
  ]
};
