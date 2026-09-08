/* ═══════════════════════════════════════════════════════════════════════════
   data.js — the last-known-good dataset, baked in at build time.

   The page prefers the live file at `data/faucet.json`, which the engine
   rewrites on every cycle. This copy exists so the site still renders real
   numbers when it is opened straight off disk (file:// blocks fetch) or when
   the JSON has not been regenerated yet. Never hand-edit it: regenerate with
   `npm run sync:fallback`.
   ═══════════════════════════════════════════════════════════════════════════ */

window.FAUCET_FALLBACK = {
  "generatedAt": "2026-09-08T18:20:49.279Z",
  "mode": "live",
  "project": {
    "name": "Robinhood",
    "ticker": "ROBIN",
    "tagline": "Every creator reward buys the coin back and burns it.",
    "launchpad": "Pons",
    "chain": "Robinhood Chain"
  },
  "chain": {
    "chainId": 4663,
    "name": "Robinhood Chain",
    "explorerTx": "https://robinhoodchain.blockscout.com/tx/"
  },
  "token": {
    "address": "0xd6e1d091f2029fe0122ddcc90936bdd255f5828b",
    "symbol": "ROBIN",
    "decimals": 18
  },
  "native": {
    "address": null,
    "symbol": "ETH",
    "decimals": 18
  },
  "devWallet": "0xfb2e3601F80Fc03Ef851df0Ba49e6f65357C5654",
  "funds": {
    "untouchedRaw": "245802981358656453",
    "untouched": "0.245802",
    "recordedAt": "2026-09-08T18:17:30.839Z",
    "claimedPoolRaw": "976036461202000",
    "claimedPool": "0.000976"
  },
  "burnAddress": "0x000000000000000000000000000000000000dEaD",
  "venues": {
    "feeEscrow": "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
    "factory": "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    "hook": "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    "universalRouter": "0x8876789976decbfcbbbe364623c63652db8c0904",
    "poolManager": "0x8366a39cc670b4001a1121b8f6a443a643e40951"
  },
  "policy": [
    {
      "bucket": "buyback",
      "label": "Buyback & burn",
      "bps": 10000,
      "intent": "Every creator reward claimed from the Pons fee escrow is spent buying the token, on its bonding curve before graduation and on the Uniswap v4 pool after, with the tokens delivered directly to the burn address."
    }
  ],
  "limits": {
    "gasReserve": "0.001",
    "minBuyback": "0.002",
    "minClaim": "0.0005",
    "slippageBps": 300,
    "deadlineSeconds": 180,
    "intervalSeconds": 180
  },
  "totals": {
    "burns": 1,
    "claims": 1,
    "claimedRaw": "77364399446655139",
    "claimed": "0.0773",
    "ethSpentRaw": "76356693138799139",
    "ethSpent": "0.0763",
    "tokensBurnedRaw": "19888297979828808730935038",
    "tokensBurned": "19,888,297.97",
    "gasRaw": "31669846654000",
    "gas": "0.000031",
    "supplyRaw": "1000000000000000000000000000",
    "supplyBurnedPct": "1.9888%",
    "lastBurnAt": "2026-09-08T18:20:40.000Z",
    "lastClaimAt": "2026-09-08T18:20:31.000Z"
  },
  "burns": [
    {
      "id": 1,
      "txHash": "0xbe044166402e2638cc54ed1328119f52377c28814c7b6163ef27a42af4a78bd2",
      "block": 57899881,
      "timestamp": "2026-09-08T18:20:40.000Z",
      "mode": "live",
      "venue": "pons-curve",
      "ethSpentRaw": "76356693138799139",
      "ethSpent": "0.0763",
      "tokensBurnedRaw": "19888297979828808730935038",
      "tokensBurned": "19,888,297.97",
      "expectedOut": "19,888,297.97",
      "minOut": "19,291,649.04",
      "slippageRealisedBps": 0,
      "gas": "0.000023",
      "explorerUrl": "https://robinhoodchain.blockscout.com/tx/0xbe044166402e2638cc54ed1328119f52377c28814c7b6163ef27a42af4a78bd2",
      "claimTx": "0xb4a743cd972ecbdfca181baf87117bc7393969b9371ebdbacd96af18e0d75ea9",
      "claimUrl": "https://robinhoodchain.blockscout.com/tx/0xb4a743cd972ecbdfca181baf87117bc7393969b9371ebdbacd96af18e0d75ea9"
    }
  ],
  "claims": [
    {
      "txHash": "0xb4a743cd972ecbdfca181baf87117bc7393969b9371ebdbacd96af18e0d75ea9",
      "block": 57899788,
      "timestamp": "2026-09-08T18:20:31.000Z",
      "mode": "live",
      "amountRaw": "77364399446655139",
      "amount": "0.0773",
      "gas": "0.000007",
      "explorerUrl": "https://robinhoodchain.blockscout.com/tx/0xb4a743cd972ecbdfca181baf87117bc7393969b9371ebdbacd96af18e0d75ea9"
    }
  ]
};
