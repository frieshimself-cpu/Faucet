/* verify.js — look a transaction hash up in the published ledger and hand
   the reader the explorer link. The chain is the source of truth; this is a
   convenience over the ledger the engine wrote, and it says so. */

(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const form = el('verifyForm'), input = el('verifyHash'), samples = el('verifySamples');
  const empty = el('verifyEmpty'), panel = el('verifyPanel'), status = el('verifyStatus'), facts = el('verifyFacts');
  if (!form || !input) return;
  let data = null;

  function show(state, html) { empty.hidden = true; panel.hidden = false; status.className = `verify__status verify__status--${state}`; status.innerHTML = html; }

  function lookup(hash) {
    const h = String(hash || '').trim();
    input.value = h;
    el('vCli').textContent = `faucet verify ${h || '<txhash>'}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) { show('warn', 'A transaction hash is 0x followed by 64 hex characters.'); facts.innerHTML = ''; return; }
    const b = (data.burns || []).find((x) => x.txHash.toLowerCase() === h.toLowerCase());
    if (!b) {
      facts.innerHTML = '';
      show('no', `<b>Not in the ledger.</b> ${data.chain.explorerTx ? `Check it on the explorer: <a href="${data.chain.explorerTx}${h}" rel="noopener">${h.slice(0, 14)}…</a>. A burn shows a ${data.token.symbol} Transfer to ${data.burnAddress.slice(0, 8)}…dEaD.` : 'The explorer link is not configured yet; use <code>faucet verify</code> against the chain.'}`);
      return;
    }
    const eth = data.native.symbol, tok = data.token.symbol;
    facts.innerHTML = [
      ['Burn', `#${b.id}`], ['When', b.timestamp.replace('T', ' ').slice(0, 19) + ' UTC'], ['Block', b.block.toLocaleString()],
      ['Spent', `${b.ethSpent} ${eth}`], ['Burned', `${b.tokensBurned} ${tok}`], ['Quote', `${b.expectedOut} ${tok}`],
      ['Min out', `${b.minOut} ${tok}`], ['Gas', `${b.gas} ${eth}`], ['Recipient', data.burnAddress],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd class="mono">${v}</dd></div>`).join('');
    show(b.mode === 'mock' ? 'warn' : 'ok',
      b.mode === 'mock'
        ? `<b>Found in the ledger, mock chain.</b> This burn was produced pre-launch against the in-memory chain; the hash is a placeholder and does not exist on Robinhood Chain.`
        : `<b>Found in the ledger.</b> Confirm on the explorer: <a href="${b.explorerUrl}" rel="noopener">open transaction</a>. The ${tok} Transfer in it should show ${data.burnAddress.slice(0, 8)}…dEaD as recipient.`);
    document.getElementById('verify').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  window.FaucetVerify = {
    init(d) {
      data = d;
      const picks = (d.burns || []).slice(-3).reverse();
      samples.innerHTML = picks.length ? 'From the ledger: ' + picks.map((b) => `<button type="button" class="verify__sample mono" data-hash="${b.txHash}">burn #${b.id}</button>`).join(' ') : '';
      samples.addEventListener('click', (e) => { const b = e.target.closest('[data-hash]'); if (b) lookup(b.dataset.hash); });
      form.addEventListener('submit', (e) => { e.preventDefault(); lookup(input.value); });
    },
    lookup,
  };
})();
