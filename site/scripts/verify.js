/* ═══════════════════════════════════════════════════════════════════════════
   verify.js — the drip verifier.

   Loads an epoch's published claim file, rebuilds its Merkle tree in the
   browser (merkle.js, cross-tested against the engine), derives the proof for
   a wallet, and shows whether the recomputed root matches the published one.
   Nothing typed here leaves the page; the only network request is for the
   static claim file itself.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const M = window.FaucetMerkle;
  if (!M) return;

  const el = (id) => document.getElementById(id);
  const form = el('verifyForm');
  const epochSelect = el('verifyEpoch');
  const ownerInput = el('verifyOwner');
  const samples = el('verifySamples');
  const empty = el('verifyEmpty');
  const panel = el('verifyPanel');
  const status = el('verifyStatus');
  if (!form || !epochSelect || !ownerInput) return;

  const cache = new Map(); /* epoch -> { file, claims, tree } */
  let index = [];
  let native = { symbol: 'SOL', decimals: 9 };

  function formatAmount(raw, decimals) {
    const s = BigInt(raw).toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = s.slice(-decimals).slice(0, 4).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }

  function short(hash) {
    return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  }

  async function loadEpoch(epoch) {
    if (cache.has(epoch)) return cache.get(epoch);
    const entry = index.find((e) => e.epoch === epoch);
    if (!entry) throw new Error(`no claim file for epoch ${epoch}`);
    const response = await fetch(`data/${entry.file}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`could not load ${entry.file} (HTTP ${response.status})`);
    const file = await response.json();
    const claims = M.parseClaimFile(file);
    const tree = await M.buildTree(claims);
    const bundle = { entry, file, claims, tree };
    cache.set(epoch, bundle);
    return bundle;
  }

  function show(state, html) {
    empty.hidden = true;
    panel.hidden = false;
    status.className = `verify__status verify__status--${state}`;
    status.innerHTML = html;
  }

  function renderSamples(bundle) {
    /* Three real owners from the file, so the tool can be tried in one click. */
    const picks = [0, Math.floor(bundle.claims.length / 2), bundle.claims.length - 1]
      .filter((i, k, a) => a.indexOf(i) === k && bundle.claims[i]);
    samples.innerHTML =
      'Sample wallets from this epoch: ' +
      picks
        .map((i) => `<button type="button" class="verify__sample mono" data-owner="${bundle.claims[i].owner}">${short(bundle.claims[i].owner)}</button>`)
        .join(' ');
  }

  async function run() {
    const epoch = Number(epochSelect.value);
    const owner = ownerInput.value.trim();
    if (!owner) {
      show('warn', 'Paste a wallet address, or pick one of the samples.');
      el('vOwner').textContent = '';
      return;
    }

    show('busy', 'Rebuilding the tree…');
    const bundle = await loadEpoch(epoch);
    const { file, claims, tree } = bundle;

    const claim = claims.find((c) => c.owner === owner);
    el('vLeaves').textContent = String(claims.length);
    el('vRootPub').textContent = file.root;
    el('vRootMine').textContent = tree.root;
    el('vCli').textContent = `faucet verify data/claims/epoch-${epoch}.json ${owner}`;

    const rootsAgree = tree.root === file.root;

    if (!claim) {
      el('vOwner').textContent = owner;
      el('vIndex').textContent = '—';
      el('vAmount').textContent = '—';
      el('vProof').innerHTML = '';
      el('vProofCount').textContent = '';
      show(
        'no',
        `<b>No claim for this wallet in epoch ${epoch}.</b> ` +
          (rootsAgree
            ? `The tree was rebuilt from ${claims.length} published claims and its root matches the published root, so the file is intact; this wallet simply is not in it.`
            : `The rebuilt root does <em>not</em> match the published root. The claim file has been altered.`),
      );
      return;
    }

    const proof = M.proofFor(tree, claim.index);
    const valid = await M.verifyProof(claim, proof, file.root);

    el('vOwner').textContent = claim.owner;
    el('vIndex').textContent = String(claim.index);
    el('vAmount').textContent = `${formatAmount(claim.amount, native.decimals)} ${native.symbol}`;
    el('vProofCount').textContent = `· ${proof.length} sibling hash${proof.length === 1 ? '' : 'es'}`;
    el('vProof').innerHTML = proof.map((h, i) => `<li><span class="verify__lvl">L${i}</span><code>${h}</code></li>`).join('');

    if (valid && rootsAgree) {
      show('ok', `<b>Proof valid.</b> Leaf ${claim.index} of ${claims.length} hashes up to the published root in ${proof.length} steps.`);
    } else {
      show('no', `<b>Proof invalid.</b> The recomputed root differs from the published one.`);
    }
  }

  window.FaucetVerify = {
    async init(data) {
      native = data.native || native;
      try {
        const response = await fetch('data/claims/index.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        index = await response.json();
      } catch (_) {
        index = [];
      }

      if (index.length === 0) {
        epochSelect.innerHTML = '<option>none published</option>';
        epochSelect.disabled = true;
        ownerInput.disabled = true;
        empty.innerHTML = '<p>No claim files are published yet. Serve the site over HTTP after <code>npm run cycle</code>.</p>';
        return;
      }

      epochSelect.innerHTML = index
        .slice()
        .sort((a, b) => b.epoch - a.epoch)
        .map((e) => `<option value="${e.epoch}">Epoch ${e.epoch} · ${e.claims} claims</option>`)
        .join('');

      const refreshSamples = async () => {
        try { renderSamples(await loadEpoch(Number(epochSelect.value))); } catch (_) { samples.textContent = ''; }
      };
      epochSelect.addEventListener('change', refreshSamples);
      await refreshSamples();

      samples.addEventListener('click', (event) => {
        const button = event.target.closest('[data-owner]');
        if (!button) return;
        ownerInput.value = button.dataset.owner;
        run().catch((error) => show('no', `<b>Could not verify.</b> ${error.message}`));
      });

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        run().catch((error) => show('no', `<b>Could not verify.</b> ${error.message}`));
      });
    },
    /** Used by the ledger's "verify in this epoch" links. */
    focusEpoch(epoch) {
      epochSelect.value = String(epoch);
      epochSelect.dispatchEvent(new Event('change'));
      document.getElementById('verify').scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => ownerInput.focus(), 500);
    },
  };
})();
