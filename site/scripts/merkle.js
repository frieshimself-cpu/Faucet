/* ═══════════════════════════════════════════════════════════════════════════
   merkle.js — the claim tree, in the browser.

   A line-for-line port of engine/src/merkle.ts onto WebCrypto, so a holder
   can rebuild an epoch's tree from the published claim file and check the
   root themselves, with nothing but this page. The engine's test suite runs
   this exact file against the TypeScript implementation and asserts the
   roots and proofs agree byte for byte (engine/test/browser-merkle.test.ts).

   Encoding, identical to the engine:
     leaf = sha256(0x00 ‖ u32be(index) ‖ utf8(owner) ‖ u64be(amount))
     node = sha256(0x01 ‖ min(a,b) ‖ max(a,b))
     an odd node at a level is promoted, never paired with itself
     empty tree root = sha256("faucet:empty")
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaucetMerkle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  const encoder = new TextEncoder();

  const LEAF = new Uint8Array([0x00]);
  const NODE = new Uint8Array([0x01]);

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  async function sha256(parts) {
    if (!subtle) throw new Error('WebCrypto is not available in this context');
    return new Uint8Array(await subtle.digest('SHA-256', concat(parts)));
  }

  function toHex(bytes) {
    let s = '0x';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  function fromHex(hex) {
    const body = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (body.length % 2 !== 0 || /[^0-9a-fA-F]/.test(body)) throw new Error(`not a hex string: ${hex}`);
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function u32be(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`index out of u32 range: ${n}`);
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  function u64be(value) {
    const v = BigInt(value);
    if (v < 0n) throw new Error(`negative amount in leaf: ${v}`);
    if (v > 0xffffffffffffffffn) throw new Error(`amount overflows u64: ${v}`);
    const out = new Uint8Array(8);
    let x = v;
    for (let i = 7; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }

  function compare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  }

  function hashClaim(claim) {
    return sha256([LEAF, u32be(claim.index), encoder.encode(claim.owner), u64be(claim.amount)]);
  }

  function hashPair(a, b) {
    const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
    return sha256([NODE, lo, hi]);
  }

  async function buildTree(claims) {
    if (claims.length === 0) {
      const empty = await sha256([encoder.encode('faucet:empty')]);
      return { root: toHex(empty), levels: [[]] };
    }

    const levels = [await Promise.all(claims.map(hashClaim))];

    while (levels[levels.length - 1].length > 1) {
      const current = levels[levels.length - 1];
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1];
        next.push(right === undefined ? left : await hashPair(left, right));
      }
      levels.push(next);
    }

    return { root: toHex(levels[levels.length - 1][0]), levels };
  }

  function proofFor(tree, index) {
    const leaves = tree.levels[0];
    if (index < 0 || index >= leaves.length) throw new Error(`no leaf at index ${index} (tree has ${leaves.length})`);

    const proof = [];
    let position = index;
    for (let level = 0; level < tree.levels.length - 1; level++) {
      const nodes = tree.levels[level];
      const sibling = nodes[position % 2 === 1 ? position - 1 : position + 1];
      if (sibling !== undefined) proof.push(toHex(sibling));
      position = Math.floor(position / 2);
    }
    return proof;
  }

  async function verifyProof(claim, proof, root) {
    let node = await hashClaim(claim);
    for (const step of proof) node = await hashPair(node, fromHex(step));
    return toHex(node) === root;
  }

  /** Parse a published claim file into the shape the tree wants. */
  function parseClaimFile(file) {
    return file.claims.map((c) => ({ index: c.index, owner: c.owner, amount: BigInt(c.amountRaw) }));
  }

  return { buildTree, proofFor, verifyProof, hashClaim, parseClaimFile, toHex, fromHex };
});
