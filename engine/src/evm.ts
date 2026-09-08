/**
 * The chain boundary.
 *
 * Everything the engine needs from Robinhood Chain fits in one small
 * interface, so the buyback logic can be tested against an in-memory chain
 * and the live adapter stays thin. The live adapter is ethers v6; it is the
 * engine's one runtime dependency, because hand-rolling secp256k1 for code
 * that moves money would be the wrong kind of clever.
 */

import { Contract, Interface, JsonRpcProvider, Wallet, type TransactionReceipt } from 'ethers';
import type { Address, Raw, SwapReceipt } from './types.js';

export interface SwapToBurnParams {
  readonly router: Address;
  readonly amountInWei: Raw;
  readonly amountOutMin: Raw;
  readonly path: readonly Address[];
  readonly to: Address;
  readonly deadline: number;
}

export interface Chain {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  balance(address: Address): Promise<Raw>;
  quote(router: Address, amountInWei: Raw, path: readonly Address[]): Promise<Raw>;
  tokenTotalSupply(token: Address): Promise<Raw>;
  tokenBalance(token: Address, owner: Address): Promise<Raw>;
  /** Signs and broadcasts; returns the hash as soon as the node accepts it. */
  swapToBurn(params: SwapToBurnParams): Promise<string>;
  /** Waits for the receipt and reads the token transfers into `burnAddress`. */
  receipt(txHash: string, token: Address, burnAddress: Address): Promise<SwapReceipt>;
}

const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
];

const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const erc20 = new Interface(ERC20_ABI);
const TRANSFER_TOPIC = erc20.getEvent('Transfer')!.topicHash;

export interface EthersChainOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Required only to send. Reads work without it. */
  readonly privateKey?: string | undefined;
}

export class EthersChain implements Chain {
  readonly #provider: JsonRpcProvider;
  readonly #wallet: Wallet | null;

  constructor(options: EthersChainOptions) {
    // Pinning the chain id makes ethers refuse to talk to the wrong network.
    this.#provider = new JsonRpcProvider(options.rpcUrl, options.chainId, { staticNetwork: true });
    this.#wallet = options.privateKey ? new Wallet(options.privateKey, this.#provider) : null;
  }

  get signer(): Address | null {
    return this.#wallet ? (this.#wallet.address as Address) : null;
  }

  async chainId(): Promise<number> {
    return Number((await this.#provider.getNetwork()).chainId);
  }

  blockNumber(): Promise<number> {
    return this.#provider.getBlockNumber();
  }

  balance(address: Address): Promise<Raw> {
    return this.#provider.getBalance(address);
  }

  async quote(router: Address, amountInWei: Raw, path: readonly Address[]): Promise<Raw> {
    const contract = new Contract(router, ROUTER_ABI, this.#provider);
    const amounts = (await contract.getFunction('getAmountsOut')(amountInWei, [...path])) as bigint[];
    const last = amounts[amounts.length - 1];
    if (last === undefined) throw new Error('router returned an empty quote');
    return last;
  }

  async tokenTotalSupply(token: Address): Promise<Raw> {
    return (await new Contract(token, ERC20_ABI, this.#provider).getFunction('totalSupply')()) as bigint;
  }

  async tokenBalance(token: Address, owner: Address): Promise<Raw> {
    return (await new Contract(token, ERC20_ABI, this.#provider).getFunction('balanceOf')(owner)) as bigint;
  }

  async swapToBurn(params: SwapToBurnParams): Promise<string> {
    if (!this.#wallet) throw new Error('no signer: set FAUCET_DEV_WALLET_KEY to execute');
    const contract = new Contract(params.router, ROUTER_ABI, this.#wallet);
    const tx = await contract.getFunction('swapExactETHForTokensSupportingFeeOnTransferTokens')(
      params.amountOutMin,
      [...params.path],
      params.to,
      params.deadline,
      { value: params.amountInWei },
    );
    return tx.hash as string;
  }

  async receipt(txHash: string, token: Address, burnAddress: Address): Promise<SwapReceipt> {
    const receipt: TransactionReceipt | null = await this.#provider.waitForTransaction(txHash, 1, 180_000);
    if (!receipt) throw new Error(`no receipt for ${txHash} after 180s`);
    const block = await this.#provider.getBlock(receipt.blockNumber);

    return {
      txHash,
      status: receipt.status === 1 ? 'success' : 'reverted',
      block: receipt.blockNumber,
      timestamp: block?.timestamp ?? 0,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      tokensToBurn: tokensTransferredTo(receipt.logs, token, burnAddress),
    };
  }
}

/** Sums ERC-20 Transfer amounts for `token` whose recipient is `to`. */
export function tokensTransferredTo(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
  token: Address,
  to: Address,
): Raw {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const parsed = erc20.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) continue;
    if (String(parsed.args[1]).toLowerCase() !== to.toLowerCase()) continue;
    total += BigInt(parsed.args[2]);
  }
  return total;
}

/* ── an in-memory chain for tests and dry runs ───────────────────────────── */

export interface MockChainOptions {
  readonly chainId?: number;
  readonly wallet: Address;
  readonly token: Address;
  readonly burnAddress: Address;
  readonly balance: Raw;
  /** Token units received per wei at the first quote. */
  readonly tokensPerWei: bigint;
  /** Price impact per wei spent, in parts per 1e18. */
  readonly impactPer1e18?: bigint;
  readonly totalSupply: Raw;
  readonly gasUsed?: Raw;
  readonly gasPrice?: Raw;
  /** Force the executed price below the quote, to exercise slippage protection. */
  readonly executionDriftBps?: number;
}

export class MockChain implements Chain {
  readonly #o: Required<MockChainOptions>;
  #balance: Raw;
  #block = 1_000_000;
  #burned = 0n;
  #sent = new Map<string, SwapReceipt>();
  readonly calls: string[] = [];

  constructor(options: MockChainOptions) {
    this.#o = {
      chainId: 0,
      impactPer1e18: 0n,
      gasUsed: 160_000n,
      gasPrice: 100_000_000n,
      executionDriftBps: 0,
      ...options,
    };
    this.#balance = options.balance;
  }

  get burned(): Raw {
    return this.#burned;
  }

  credit(wei: Raw): void {
    this.#balance += wei;
  }

  async chainId(): Promise<number> {
    return this.#o.chainId;
  }

  async blockNumber(): Promise<number> {
    return this.#block;
  }

  async balance(address: Address): Promise<Raw> {
    this.calls.push(`balance:${address}`);
    return address.toLowerCase() === this.#o.wallet.toLowerCase() ? this.#balance : 0n;
  }

  async quote(_router: Address, amountInWei: Raw, _path: readonly Address[]): Promise<Raw> {
    this.calls.push(`quote:${amountInWei}`);
    return this.#priceOut(amountInWei);
  }

  async tokenTotalSupply(): Promise<Raw> {
    return this.#o.totalSupply;
  }

  async tokenBalance(_token: Address, owner: Address): Promise<Raw> {
    return owner.toLowerCase() === this.#o.burnAddress.toLowerCase() ? this.#burned : 0n;
  }

  async swapToBurn(params: SwapToBurnParams): Promise<string> {
    this.calls.push(`swap:${params.amountInWei}:${params.to}`);
    if (params.to.toLowerCase() !== this.#o.burnAddress.toLowerCase()) {
      throw new Error(`mock chain: swap recipient ${params.to} is not the burn address`);
    }
    if (params.amountInWei > this.#balance) throw new Error('mock chain: insufficient balance');

    const gasCost = this.#o.gasUsed * this.#o.gasPrice;
    const out = (this.#priceOut(params.amountInWei) * BigInt(10_000 - this.#o.executionDriftBps)) / 10_000n;
    const hash = `0x${(this.#sent.size + 1).toString(16).padStart(64, '0')}`;
    this.#block += 1;

    if (out < params.amountOutMin) {
      // A real router reverts and the value is returned; only gas is lost.
      this.#balance -= gasCost;
      this.#sent.set(hash, {
        txHash: hash, status: 'reverted', block: this.#block, timestamp: 1_760_000_000 + this.#block,
        gasUsed: this.#o.gasUsed, effectiveGasPrice: this.#o.gasPrice, tokensToBurn: 0n,
      });
      return hash;
    }

    this.#balance -= params.amountInWei + gasCost;
    this.#burned += out;
    this.#sent.set(hash, {
      txHash: hash, status: 'success', block: this.#block, timestamp: 1_760_000_000 + this.#block,
      gasUsed: this.#o.gasUsed, effectiveGasPrice: this.#o.gasPrice, tokensToBurn: out,
    });
    return hash;
  }

  async receipt(txHash: string): Promise<SwapReceipt> {
    const r = this.#sent.get(txHash);
    if (!r) throw new Error(`mock chain: unknown tx ${txHash}`);
    return r;
  }

  #priceOut(amountInWei: Raw): Raw {
    const linear = amountInWei * this.#o.tokensPerWei;
    // Constant-product-ish impact: out shrinks with size.
    const impact = (linear * this.#o.impactPer1e18 * amountInWei) / (10n ** 36n);
    return linear - impact;
  }
}
