/* ═══════════════════════════════════════════════════════════════════════════
   data.js — the last-known-good dataset, baked in at build time.

   The page prefers the live file at `data/faucet.json`, which the engine
   rewrites on every cycle. This copy exists so the site still renders real
   numbers when it is opened straight off disk (file:// blocks fetch) or when
   the JSON has not been regenerated yet. Never hand-edit it: regenerate with
   `npm run sync:fallback`.
   ═══════════════════════════════════════════════════════════════════════════ */

window.FAUCET_FALLBACK = {
  "generatedAt": "2026-09-10T20:33:33.141Z",
  "mode": "none",
  "project": {
    "name": "Robinhood",
    "ticker": "FAUCET",
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
    "address": "0x6d1b86adfd30d7913d5f0dae6568bd566e6b6327",
    "symbol": "FAUCET",
    "decimals": 18
  },
  "native": {
    "address": null,
    "symbol": "ETH",
    "decimals": 18
  },
  "devWallet": null,
  "funds": {
    "untouchedRaw": null,
    "untouched": null,
    "recordedAt": null,
    "claimedPoolRaw": "0",
    "claimedPool": "0"
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
    "burns": 0,
    "claims": 0,
    "claimedRaw": "0",
    "claimed": "0",
    "ethSpentRaw": "0",
    "ethSpent": "0",
    "tokensBurnedRaw": "0",
    "tokensBurned": "0",
    "gasRaw": "0",
    "gas": "0",
    "supplyRaw": null,
    "supplyBurnedPct": null,
    "lastBurnAt": null,
    "lastClaimAt": null
  },
  "burns": [],
  "claims": []
};
