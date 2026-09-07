import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTree, hashClaim, proofFor, toHex, verifyProof } from '../src/merkle.js';
import type { Claim } from '../src/types.js';

function claims(n: number): Claim[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    owner: `owner-${i}`,
    amount: BigInt((i + 1) * 1_000),
  }));
}

test('every leaf in a tree has a valid proof', () => {
  // Odd sizes exercise the promote-the-orphan path, which is where naive
  // implementations start producing proofs that verify for the wrong leaf.
  for (const size of [1, 2, 3, 5, 8, 9, 17, 64, 101]) {
    const set = claims(size);
    const tree = buildTree(set);
    for (const claim of set) {
      const proof = proofFor(tree, claim.index);
      assert.equal(verifyProof(claim, proof, tree.root), true, `size ${size} index ${claim.index}`);
    }
  }
});

test('a tampered amount invalidates the proof', () => {
  const set = claims(11);
  const tree = buildTree(set);
  const target = set[4] as Claim;
  const proof = proofFor(tree, target.index);

  assert.equal(verifyProof({ ...target, amount: target.amount + 1n }, proof, tree.root), false);
  assert.equal(verifyProof({ ...target, owner: 'attacker' }, proof, tree.root), false);
  assert.equal(verifyProof({ ...target, index: 5 }, proof, tree.root), false);
});

test("one holder's proof does not validate another holder's leaf", () => {
  const set = claims(16);
  const tree = buildTree(set);
  const proof = proofFor(tree, 3);
  assert.equal(verifyProof(set[7] as Claim, proof, tree.root), false);
});

test('leaf and node hashes use different domains', () => {
  // Without the 0x00/0x01 prefixes an internal node could be presented as a
  // leaf, letting anyone mint a claim for an amount that was never allocated.
  const leaf = hashClaim({ index: 0, owner: 'a', amount: 1n });
  const tree = buildTree(claims(4));
  const internal = (tree.levels[1] as readonly Uint8Array[])[0] as Uint8Array;
  assert.notEqual(toHex(leaf), toHex(internal));
});

test('the empty tree has a stable root and no proofs', () => {
  const tree = buildTree([]);
  assert.match(tree.root, /^0x[0-9a-f]{64}$/);
  assert.equal(tree.root, buildTree([]).root);
  assert.throws(() => proofFor(tree, 0), /no leaf at index/);
});

test('tree construction is deterministic', () => {
  assert.equal(buildTree(claims(37)).root, buildTree(claims(37)).root);
});

test('amounts that overflow u64 are rejected rather than truncated', () => {
  assert.throws(() => hashClaim({ index: 0, owner: 'a', amount: 2n ** 64n }), /overflows u64/);
  assert.throws(() => hashClaim({ index: 0, owner: 'a', amount: -1n }), /negative/);
});
