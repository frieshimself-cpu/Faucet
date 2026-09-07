/**
 * Watches a fee vault account and reports every credit inside a slot window.
 *
 * A fee "receipt" is a finalized transaction whose net effect on the vault is
 * positive. Reading the balance delta rather than parsing program logs means the
 * adapter keeps working when Pons ships a new program version — a fee that lands
 * in the vault is a fee, whoever routed it there.
 */

import type { SolanaRpc } from '../rpc.js';
import type {
  CollectionResult,
  FeeReceipt,
  FeeSource,
  FeeSourceKind,
  Mint,
  SlotWindow,
} from '../types.js';

export interface VaultSourceOptions {
  readonly kind: FeeSourceKind;
  readonly label: string;
  readonly vault: string;
  readonly mint: Mint;
  readonly rpc: SolanaRpc;
  /** Cap on signatures pulled per pass, so one busy epoch can't run forever. */
  readonly maxSignatures?: number;
}

export class VaultFeeSource implements FeeSource {
  readonly kind: FeeSourceKind;
  readonly label: string;
  readonly #options: VaultSourceOptions;

  constructor(options: VaultSourceOptions) {
    this.kind = options.kind;
    this.label = options.label;
    this.#options = options;
  }

  async collect(window: SlotWindow): Promise<CollectionResult> {
    const { rpc, vault, mint, maxSignatures = 5_000 } = this.#options;

    if (window.toSlot <= window.fromSlot) {
      return { source: this.kind, window, receipts: [], total: 0n };
    }

    const signatures: Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }> = [];
    let before: string | undefined;

    // Paginate backwards until we fall out of the window or hit the cap.
    paging: while (signatures.length < maxSignatures) {
      const page = await rpc.getSignaturesForAddress(vault, before === undefined ? {} : { before });
      if (page.length === 0) break;

      for (const entry of page) {
        if (entry.slot >= window.toSlot) continue;
        if (entry.slot < window.fromSlot) break paging;
        if (entry.err !== null) continue; // Failed transactions moved nothing.
        signatures.push(entry);
      }

      const last = page[page.length - 1];
      if (!last) break;
      before = last.signature;
    }

    const receipts: FeeReceipt[] = [];

    for (const entry of signatures) {
      const tx = await rpc.getTransaction(entry.signature);
      const delta = vaultDelta(tx, vault);
      if (delta <= 0n) continue;
      receipts.push({
        source: this.kind,
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime,
        amount: delta,
        mint,
      });
    }

    const total = receipts.reduce((sum, r) => sum + r.amount, 0n);
    return { source: this.kind, window, receipts, total };
  }
}

/** Net lamports the vault gained in this transaction; negative or zero is ignored upstream. */
export function vaultDelta(tx: { meta: { preBalances: number[]; postBalances: number[]; err: unknown } | null; transaction: { message: { accountKeys: Array<{ pubkey: string } | string> } } } | null, vault: string): bigint {
  if (!tx?.meta || tx.meta.err !== null) return 0n;

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const index = keys.indexOf(vault);
  if (index === -1) return 0n;

  const pre = tx.meta.preBalances[index];
  const post = tx.meta.postBalances[index];
  if (pre === undefined || post === undefined) return 0n;

  return BigInt(post) - BigInt(pre);
}
