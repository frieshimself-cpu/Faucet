/**
 * A minimal, dependency-free Merkle tree for drip claims.
 *
 * Design notes, because the details here are the difference between a working
 * claim contract and a fun exploit:
 *
 *  - Leaves and internal nodes use different hash prefixes (0x00 / 0x01) so a
 *    64-byte "leaf" can never be re-read as an internal node. Without this an
 *    attacker can forge a proof for a leaf that was never in the tree.
 *  - Internal pairs are hashed in sorted order, so a proof is just a list of
 *    sibling hashes — the verifier needs no left/right bitmap.
 *  - An odd node at a level is promoted, not duplicated. Duplicating the last
 *    node lets the same proof validate two different indices.
 */

import { createHash } from 'node:crypto';
import type { Claim, Raw } from './types.js';

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || /[^0-9a-fA-F]/.test(body)) {
    throw new Error(`not a hex string: ${hex}`);
  }
  return new Uint8Array(Buffer.from(body, 'hex'));
}

/** Big-endian u64. Amounts above 2^64-1 are a bug, not a big number. */
function u64be(value: Raw): Uint8Array {
  if (value < 0n) throw new Error(`negative amount in leaf: ${value}`);
  if (value > 0xffff_ffff_ffff_ffffn) throw new Error(`amount overflows u64: ${value}`);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(value);
  return new Uint8Array(buf);
}

function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`index out of u32 range: ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return new Uint8Array(buf);
}

/**
 * leaf = sha256(0x00 || u32be(index) || utf8(owner) || u64be(amount))
 *
 * The index is inside the hash so a claim contract can mark index `n` as spent
 * in a bitmap and be certain no second leaf shares it.
 */
export function hashClaim(claim: Claim): Uint8Array {
  return sha256(LEAF_PREFIX, u32be(claim.index), new TextEncoder().encode(claim.owner), u64be(claim.amount));
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(NODE_PREFIX, lo, hi);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return a.length - b.length;
}

export interface BuiltTree {
  readonly root: string;
  readonly levels: readonly (readonly Uint8Array[])[];
}

export function buildTree(claims: readonly Claim[]): BuiltTree {
  if (claims.length === 0) {
    // An empty epoch still needs a well-defined root so downstream code has no
    // special case. sha256("faucet:empty") carries neither the leaf nor the node
    // prefix, so it can never collide with a real hash — and the leaf level is
    // left empty so `proofFor` cannot hand out a proof for the sentinel itself.
    const empty = sha256(new TextEncoder().encode('faucet:empty'));
    return { root: toHex(empty), levels: [[]] };
  }

  const levels: Uint8Array[][] = [claims.map(hashClaim)];

  while ((levels[levels.length - 1] as Uint8Array[]).length > 1) {
    const current = levels[levels.length - 1] as Uint8Array[];
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i] as Uint8Array;
      const right = current[i + 1];
      // Odd node out: promote it untouched rather than pairing it with itself.
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
  }

  const top = levels[levels.length - 1] as Uint8Array[];
  return { root: toHex(top[0] as Uint8Array), levels };
}

export function proofFor(tree: BuiltTree, index: number): string[] {
  const leaves = tree.levels[0] as readonly Uint8Array[];
  if (index < 0 || index >= leaves.length) {
    throw new Error(`no leaf at index ${index} (tree has ${leaves.length})`);
  }

  const proof: string[] = [];
  let position = index;

  for (let level = 0; level < tree.levels.length - 1; level++) {
    const nodes = tree.levels[level] as readonly Uint8Array[];
    const isRight = position % 2 === 1;
    const siblingIndex = isRight ? position - 1 : position + 1;
    const sibling = nodes[siblingIndex];
    // No sibling means this node was promoted; nothing to prove at this level.
    if (sibling !== undefined) proof.push(toHex(sibling));
    position = Math.floor(position / 2);
  }

  return proof;
}

export function verifyProof(claim: Claim, proof: readonly string[], root: string): boolean {
  let node = hashClaim(claim);
  for (const step of proof) {
    node = hashPair(node, fromHex(step));
  }
  return toHex(node) === root;
}
