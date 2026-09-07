/**
 * A very small Solana JSON-RPC client.
 *
 * Deliberately dependency-free: this engine handles money, and every package it
 * pulls in is a package that can be hijacked and ship a postinstall script. The
 * six methods below are all the Faucet needs.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface RpcOptions {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
}

interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export class SolanaRpc {
  #id = 0;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(options: RpcOptions) {
    this.#url = options.url;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        // Public RPC endpoints rate-limit hard. Back off rather than hammer.
        await sleep(2 ** attempt * 250);
      }
      try {
        return await this.#once<T>(method, params);
      } catch (error) {
        lastError = error;
        if (error instanceof RpcError && error.code !== undefined && !isRetryable(error.code)) {
          throw error;
        }
      }
    }

    throw new RpcError(`${method} failed after ${this.#maxRetries + 1} attempts: ${String(lastError)}`);
  }

  async #once<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new RpcError(`HTTP ${response.status} from RPC`, response.status);
      }

      const payload = (await response.json()) as RpcResponse<T>;
      if (payload.error) throw new RpcError(payload.error.message, payload.error.code);
      if (payload.result === undefined) throw new RpcError(`empty result for ${method}`);
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getSlot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: 'finalized' }]);
  }

  getBalance(address: string): Promise<{ value: number }> {
    return this.call('getBalance', [address, { commitment: 'finalized' }]);
  }

  getSignaturesForAddress(
    address: string,
    options: { limit?: number; before?: string; until?: string } = {},
  ): Promise<Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>> {
    return this.call('getSignaturesForAddress', [address, { limit: 1_000, ...options }]);
  }

  getTransaction(signature: string): Promise<TransactionMeta | null> {
    return this.call('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
    ]);
  }

  getTokenLargestAccounts(mint: string): Promise<{ value: Array<{ address: string; amount: string }> }> {
    return this.call('getTokenLargestAccounts', [mint, { commitment: 'finalized' }]);
  }
}

export interface TransactionMeta {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string } | string>;
    };
  };
}

function isRetryable(code: number): boolean {
  // 429 and 5xx are worth another go; a malformed request never is.
  return code === 429 || code === 408 || (code >= 500 && code < 600) || code === -32005;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
