/**
 * The site ships its own Merkle implementation so holders can verify a drip
 * in the browser. It must agree with the engine byte for byte, or the page
 * would tell someone their proof is valid when the chain would reject it.
 * This loads the browser file as-is and checks every root and every proof.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildTree, proofFor, verifyProof } from '../src/merkle.js';
import type { Claim } from '../src/types.js';

interface BrowserMerkle {
  buildTree(claims: Claim[]): Promise<{ root: string; levels: Uint8Array[][] }>;
  proofFor(tree: { levels: Uint8Array[][] }, index: number): string[];
  verifyProof(claim: Claim, proof: string[], root: string): Promise<boolean>;
}

function loadBrowserMerkle(): BrowserMerkle {
  const source = readFileSync(resolve('site/scripts/merkle.js'), 'utf8');
  const module = { exports: {} as BrowserMerkle };
  // The file is a UMD wrapper: given a `module`, it exports instead of
  // attaching to window. Evaluate it exactly as the browser would.
  new Function('module', source)(module);
  return module.exports;
}

const browser = loadBrowserMerkle();

function claims(n: number): Claim[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    owner: `Hood${i.toString().padStart(3, '0')}${'x'.repeat(28)}`,
    amount: BigInt((i + 1) * 12_345_678),
  }));
}

test('browser and engine produce identical roots for every tree size', async () => {
  for (const size of [0, 1, 2, 3, 5, 8, 9, 17, 64, 120]) {
    const set = claims(size);
    const engineRoot = buildTree(set).root;
    const browserRoot = (await browser.buildTree(set)).root;
    assert.equal(browserRoot, engineRoot, `size ${size}`);
  }
});

test('browser proofs verify against the engine, and engine proofs against the browser', async () => {
  const set = claims(37);
  const engineTree = buildTree(set);
  const browserTree = await browser.buildTree(set);

  for (const claim of set) {
    const fromBrowser = browser.proofFor(browserTree, claim.index);
    const fromEngine = proofFor(engineTree, claim.index);
    assert.deepEqual(fromBrowser, fromEngine, `proof ${claim.index}`);
    assert.equal(verifyProof(claim, fromBrowser, engineTree.root), true);
    assert.equal(await browser.verifyProof(claim, fromEngine, browserTree.root), true);
  }
});

test('browser rejects a tampered claim the same way the engine does', async () => {
  const set = claims(12);
  const tree = await browser.buildTree(set);
  const target = set[4] as Claim;
  const proof = browser.proofFor(tree, 4);
  assert.equal(await browser.verifyProof({ ...target, amount: target.amount + 1n }, proof, tree.root), false);
  assert.equal(await browser.verifyProof({ ...target, owner: 'attacker' }, proof, tree.root), false);
});

test('the published claim files rebuild to their published roots in the browser', async () => {
  const index = JSON.parse(readFileSync(resolve('site/data/claims/index.json'), 'utf8')) as Array<{
    epoch: number; root: string; file: string;
  }>;
  assert.ok(index.length > 0, 'no claim files published; run npm run cycle');

  for (const entry of index) {
    const file = JSON.parse(readFileSync(resolve('site/data', entry.file), 'utf8')) as {
      root: string; claims: Array<{ index: number; owner: string; amountRaw: string }>;
    };
    const set = file.claims.map((c) => ({ index: c.index, owner: c.owner, amount: BigInt(c.amountRaw) }));
    assert.equal((await browser.buildTree(set)).root, file.root, `epoch ${entry.epoch}`);
    assert.equal(file.root, entry.root);
  }
});
