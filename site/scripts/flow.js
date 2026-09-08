/* flow.js — the valve handle on the fixture, and the "try a reward"
   calculator, which applies the engine's limits to a wallet balance using the
   rate realised at the most recent burn. */

(function () {
  'use strict';

  (function valve() {
    const handle = document.getElementById('valveHandle');
    const faucet = document.getElementById('faucet');
    const readout = document.getElementById('flowReadout');
    if (!handle || !faucet) return;
    const MAX = 270;
    let turn = 0.72 * MAX, dragging = false, grabAngle = 0, grabTurn = 0;

    const apply = () => {
      const flow = turn / MAX;
      faucet.style.setProperty('--valve-turn', `${turn}deg`);
      handle.setAttribute('aria-valuenow', String(Math.round(flow * 100)));
      if (readout) readout.textContent = `${Math.round(flow * 100)}%`;
      if (window.FaucetWater) window.FaucetWater.setFlow(flow);
    };
    const angleOf = (e) => { const b = handle.getBoundingClientRect(); return Math.atan2(e.clientY - (b.top + b.height / 2), e.clientX - (b.left + b.width / 2)) * 180 / Math.PI; };

    handle.addEventListener('pointerdown', (e) => { dragging = true; grabAngle = angleOf(e); grabTurn = turn; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      let d = angleOf(e) - grabAngle; if (d > 180) d -= 360; if (d < -180) d += 360;
      turn = Math.max(0, Math.min(MAX, grabTurn + d)); apply();
    });
    const release = (e) => { if (!dragging) return; dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch (_) {} };
    handle.addEventListener('pointerup', release); handle.addEventListener('pointercancel', release);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 27 : 13.5;
      const m = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, Home: -MAX, End: MAX }[e.key];
      if (m === undefined) return; turn = Math.max(0, Math.min(MAX, turn + m)); apply(); e.preventDefault();
    });
    apply();
  })();

  function initCalculator(d) {
    const input = document.getElementById('throughput');
    if (!input) return;
    const out = (id) => document.getElementById(id);
    const WEI = 10n ** 18n;
    const reserve = BigInt(Math.round(Number(d.limits.gasReserve.replace(/,/g, '')) * 1e18));
    const floor = BigInt(Math.round(Number(d.limits.minBuyback.replace(/,/g, '')) * 1e18));
    const slippage = BigInt(d.limits.slippageBps);

    /* Rate from the last burn: tokens per wei, as a rational (num/den). */
    const last = (d.burns || [])[d.burns.length - 1];
    const rateNum = last ? BigInt(last.tokensBurnedRaw) : 0n;
    const rateDen = last ? BigInt(last.ethSpentRaw) : 1n;
    const tokDec = BigInt(d.token.decimals);

    const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(4);
    const fmtTok = (raw) => { const s = (raw / 10n ** (tokDec - 2n)).toString().padStart(3, '0'); return `${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${s.slice(-2)}`; };

    const render = () => {
      const sol = Number(input.value);
      out('throughputValue').textContent = sol.toFixed(3);
      input.style.setProperty('--pct', `${((sol - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100).toFixed(1)}%`);
      const balance = BigInt(Math.round(sol * 1e18));
      const spendable = balance > reserve ? balance - reserve : 0n;
      const eth = d.native.symbol, tok = d.token.symbol;

      if (spendable < floor) {
        out('calcReserve').textContent = `${fmtEth(balance < reserve ? balance : reserve)} ${eth}`;
        out('calcSpend').textContent = `0 ${eth}`;
        out('calcOut').textContent = '—'; out('calcMin').textContent = '—';
        out('loopChecksum').innerHTML = `<span class="loop__checksumOk loop__checksumOk--idle"></span> Below the ${d.limits.minBuyback} ${eth} minimum. Nothing is bought; the balance waits for the next cycle.`;
        return;
      }
      const expected = rateDen > 0n ? (spendable * rateNum) / rateDen : 0n;
      const minOut = (expected * (10_000n - slippage)) / 10_000n;
      out('calcReserve').textContent = `${fmtEth(reserve)} ${eth}`;
      out('calcSpend').textContent = `${fmtEth(spendable)} ${eth}`;
      out('calcOut').textContent = last ? `${fmtTok(expected)} ${tok}` : 'no burn yet to take a rate from';
      out('calcMin').textContent = last ? `${fmtTok(minOut)} ${tok}` : '—';
      out('loopChecksum').innerHTML = `<span class="loop__checksumOk"></span> ${fmtEth(spendable)} + ${fmtEth(reserve)} = ${fmtEth(balance)} ${eth}. Rate from burn #${last ? last.id : '—'}; a live cycle quotes the market instead.`;
      void WEI;
    };
    input.addEventListener('input', render);
    render();
  }

  window.FaucetFlow = {
    init(d) {
      const s = document.getElementById('flowSlippage');
      if (s) s.textContent = `≤ ${(d.limits.slippageBps / 100).toFixed(2)}%`;
      initCalculator(d);
    },
  };
})();
