import assert from 'node:assert/strict';
import test from 'node:test';
import { vaultDelta } from '../src/sources/vault.js';

const VAULT = 'VaultAddress1111111111111111111111111111111';

function tx(pre: number[], post: number[], keys: string[], err: unknown = null) {
  return {
    meta: { preBalances: pre, postBalances: post, err },
    transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
  };
}

test('a credit to the vault is reported as its net gain', () => {
  assert.equal(vaultDelta(tx([100, 5], [90, 15], ['payer', VAULT]), VAULT), 10n);
});

test('a debit from the vault is not a fee', () => {
  assert.equal(vaultDelta(tx([100, 5], [90, 15], [VAULT, 'payee']), VAULT), -10n);
});

test('failed transactions moved nothing', () => {
  assert.equal(vaultDelta(tx([100, 5], [90, 15], ['payer', VAULT], { InstructionError: [] }), VAULT), 0n);
});

test('a transaction that does not touch the vault is ignored', () => {
  assert.equal(vaultDelta(tx([100, 5], [90, 15], ['payer', 'someone-else']), VAULT), 0n);
});

test('a transaction with no meta is ignored rather than assumed', () => {
  assert.equal(vaultDelta({ meta: null, transaction: { message: { accountKeys: [VAULT] } } }, VAULT), 0n);
});

test('string-encoded account keys are handled too', () => {
  const raw = {
    meta: { preBalances: [1, 1], postBalances: [1, 8], err: null },
    transaction: { message: { accountKeys: ['payer', VAULT] } },
  };
  assert.equal(vaultDelta(raw, VAULT), 7n);
});
