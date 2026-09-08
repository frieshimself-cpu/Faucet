/**
 * The chain boundary.
 *
 * Everything the engine needs from Robinhood Chain fits in one small
 * interface, so the cycle can be tested against an in-memory chain and the
 * live adapter stays thin. The live adapter is ethers v6; it is the engine's
 * one runtime dependency, because hand-rolling secp256k1 for code that moves
 * money would be the wrong kind of clever.
 */

import { Contract, Interface, JsonRpcProvider, Wallet, type TransactionReceipt } from 'ethers';
import {
  CURVE_ABI, ERC20_ABI, FEE_ESCROW_ABI, QUOTER_ABI, STATE_VIEW_ABI,
  calldataForLaunchRecord, decodeCurveBuyResult, decodeLaunchRecord, encodeCurveBuy, encodeV4SwapToBurn, explainRevert, poolId, poolKeyFor,
} from './pons.js';
import { NATIVE, type Address, type LaunchInfo, type Raw, type Route, type SwapReceipt, type TxReceipt } from './types.js';

/** The node refused the transaction before it was sent: nothing was signed, no gas spent. */
export class SwapRejectedError extends Error {}

function describeRejection(error: unknown): string {
  const e = error as { shortMessage?: string; reason?: string | null; data?: string | null; revert?: { args?: unknown[] } | null; message?: string; info?: { error?: { data?: string } } };
  const candidates = [e.data, e.info?.error?.data].filter((d): d is string => typeof d === 'string');
  const named = explainRevert(candidates[0] ?? null);
  const reason = named ?? e.reason ?? (e.revert?.args?.[0] as string | undefined) ?? null;
  const base = e.shortMessage ?? e.message ?? String(error);
  return reason ? `${base} (${reason})` : base;
}

export interface SwapToBurnParams {
  readonly route: Route;
  readonly token: Address;
  readonly amountInWei: Raw;
  readonly amountOutMin: Raw;
  readonly to: Address;
  readonly deadline: number;
}

export interface Chain {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  balance(address: Address): Promise<Raw>;
  tokenTotalSupply(token: Address): Promise<Raw>;
  tokenBalance(token: Address, owner: Address): Promise<Raw>;
  /** The launch record, the curve's phase, and the v4 pool's liquidity. */
  launch(token: Address): Promise<LaunchInfo>;
  /** Creator rewards waiting in the Pons fee escrow for `wallet`. */
  claimable(wallet: Address): Promise<Raw>;
  /** Signs `feeEscrow.claim()`; returns the hash once the node accepts it. */
  claim(): Promise<string>;
  /** Tokens out for `amountInWei` of ETH on the route, as the chain sees it right now. */
  quote(route: Route, token: Address, amountInWei: Raw, from: Address): Promise<Raw>;
  /** Signs and broadcasts the buy; returns the hash as soon as the node accepts it. */
  swapToBurn(params: SwapToBurnParams): Promise<string>;
  /** Waits for a receipt and reads the token transfers into `burnAddress`. */
  receipt(txHash: string, token: Address, burnAddress: Address): Promise<SwapReceipt>;
  txReceipt(txHash: string): Promise<TxReceipt>;
}

const erc20 = new Interface(ERC20_ABI);
const TRANSFER_TOPIC = erc20.getEvent('Transfer')!.topicHash;

export interface EthersChainOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Required only to send. Reads work without it. */
  readonly privateKey?: string | undefined;
  readonly contracts: {
    readonly factory: Address;
    readonly feeEscrow: Address;
    readonly hook: Address;
    readonly universalRouter: Address;
    readonly quoter: Address;
    readonly stateView: Address;
  };
}

export class EthersChain implements Chain {
  readonly #provider: JsonRpcProvider;
  readonly #wallet: Wallet | null;
  readonly #c: EthersChainOptions['contracts'];

  constructor(options: EthersChainOptions) {
    // Pinning the chain id makes ethers refuse to talk to the wrong network.
    this.#provider = new JsonRpcProvider(options.rpcUrl, options.chainId, { staticNetwork: true });
    this.#wallet = options.privateKey ? new Wallet(options.privateKey, this.#provider) : null;
    this.#c = options.contracts;
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

  async gasPrice(): Promise<Raw> {
    return (await this.#provider.getFeeData()).gasPrice ?? 0n;
  }

  async tokenTotalSupply(token: Address): Promise<Raw> {
    return (await new Contract(token, ERC20_ABI, this.#provider).getFunction('totalSupply')()) as bigint;
  }

  async tokenBalance(token: Address, owner: Address): Promise<Raw> {
    return (await new Contract(token, ERC20_ABI, this.#provider).getFunction('balanceOf')(owner)) as bigint;
  }

  async tokenSymbol(token: Address): Promise<string> {
    return (await new Contract(token, ERC20_ABI, this.#provider).getFunction('symbol')()) as string;
  }

  async launch(token: Address): Promise<LaunchInfo> {
    const raw = await this.#provider.call({ to: this.#c.factory, data: calldataForLaunchRecord(token) });
    const record = decodeLaunchRecord(token, raw);
    if (!record.exists) return { ...record, graduated: false, poolLiquidity: 0n };

    const curve = new Contract(record.curve, CURVE_ABI, this.#provider);
    const graduated = (await curve.getFunction('graduated')()) as boolean;
    let poolLiquidity = 0n;
    if (record.pairToken === NATIVE) {
      const key = poolKeyFor(token, record.tickSpacing, this.#c.hook);
      poolLiquidity = (await new Contract(this.#c.stateView, STATE_VIEW_ABI, this.#provider).getFunction('getLiquidity')(poolId(key))) as bigint;
    }
    return { ...record, graduated, poolLiquidity };
  }

  async claimable(wallet: Address): Promise<Raw> {
    return (await new Contract(this.#c.feeEscrow, FEE_ESCROW_ABI, this.#provider).getFunction('balanceOf')(wallet)) as bigint;
  }

  async claim(): Promise<string> {
    if (!this.#wallet) throw new Error('no signer: set FAUCET_DEV_WALLET_KEY to claim');
    const escrow = new Contract(this.#c.feeEscrow, FEE_ESCROW_ABI, this.#wallet);
    const tx = { to: this.#c.feeEscrow, data: escrow.interface.encodeFunctionData('claim', []) };
    try {
      const sent = await this.#wallet.sendTransaction(tx);
      return sent.hash;
    } catch (error) {
      throw new SwapRejectedError(await this.#explainRejection(error, tx));
    }
  }

  async quote(route: Route, token: Address, amountInWei: Raw, from: Address): Promise<Raw> {
    if (route.kind === 'uniswap-v4') {
      const quoter = new Contract(this.#c.quoter, QUOTER_ABI, this.#provider);
      const zeroForOne = route.poolKey.currency0 === NATIVE;
      const [amountOut] = (await quoter.getFunction('quoteExactInputSingle').staticCall({
        poolKey: route.poolKey, zeroForOne, exactAmount: amountInWei, hookData: '0x',
      })) as [bigint, bigint];
      return amountOut;
    }
    // The curve has no separate quote function; simulating the buy itself is
    // the exact answer. If the caller cannot cover the value (doctor on an
    // empty wallet) the balance is overridden for the simulation only.
    const call = { from, to: route.curve, data: encodeCurveBuy(amountInWei, 0n, '0x000000000000000000000000000000000000dEaD'), value: hex(amountInWei) };
    const balance = await this.#provider.getBalance(from);
    const params: unknown[] = [call, 'latest'];
    if (balance < amountInWei) params.push({ [from]: { balance: hex(amountInWei * 2n) } });
    const raw = (await this.#provider.send('eth_call', params)) as string;
    return decodeCurveBuyResult(raw);
  }

  async swapToBurn(params: SwapToBurnParams): Promise<string> {
    if (!this.#wallet) throw new Error('no signer: set FAUCET_DEV_WALLET_KEY to execute');
    const tx = params.route.kind === 'pons-curve'
      ? { to: params.route.curve, data: encodeCurveBuy(params.amountInWei, params.amountOutMin, params.to), value: params.amountInWei }
      : {
          to: this.#c.universalRouter,
          data: encodeV4SwapToBurn({ poolKey: params.route.poolKey, tokenOut: params.token, amountIn: params.amountInWei, minOut: params.amountOutMin, recipient: params.to, deadline: params.deadline }),
          value: params.amountInWei,
        };
    try {
      // ethers pre-flights with eth_estimateGas. A buy that would fall under
      // amountOutMin (or whose deadline passed) is refused here, before
      // anything is signed or broadcast, so it costs no gas at all.
      const sent = await this.#wallet.sendTransaction(tx);
      return sent.hash;
    } catch (error) {
      throw new SwapRejectedError(await this.#explainRejection(error, tx));
    }
  }

  /**
   * Some nodes (ganache among them) drop the revert data from a failed
   * eth_estimateGas. Re-running the same call as eth_call recovers it, so the
   * log can say *why* the buy was refused.
   */
  async #explainRejection(error: unknown, tx: { to: Address; data: string; value?: Raw }): Promise<string> {
    const first = describeRejection(error);
    if (!/missing revert data/i.test(first) || !this.#wallet) return first;
    try {
      await this.#provider.call({ ...tx, from: this.#wallet.address });
      return first;
    } catch (viaCall) {
      return describeRejection(viaCall);
    }
  }

  async txReceipt(txHash: string): Promise<TxReceipt> {
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
    };
  }

  async receipt(txHash: string, token: Address, burnAddress: Address): Promise<SwapReceipt> {
    const base = await this.txReceipt(txHash);
    const receipt = await this.#provider.getTransactionReceipt(txHash);
    return { ...base, tokensToBurn: tokensTransferredTo(receipt?.logs ?? [], token, burnAddress) };
  }

  /**
   * Doctor only: simulates the whole buy with eth_call from `from`, with a
   * balance override so it works on an empty wallet, and returns the tokens
   * the burn address would receive. Nothing is signed.
   */
  async simulateBuy(route: Route, token: Address, amountInWei: Raw, from: Address, to: Address): Promise<Raw> {
    const call = route.kind === 'pons-curve'
      ? { from, to: route.curve, data: encodeCurveBuy(amountInWei, 0n, to), value: hex(amountInWei) }
      : { from, to: this.#c.universalRouter, data: encodeV4SwapToBurn({ poolKey: route.poolKey, tokenOut: token, amountIn: amountInWei, minOut: 0n, recipient: to, deadline: Math.floor(Date.now() / 1000) + 600 }), value: hex(amountInWei) };
    const override = { [from]: { balance: hex(amountInWei * 2n) } };
    try {
      const raw = (await this.#provider.send('eth_call', [call, 'latest', override])) as string;
      if (route.kind === 'pons-curve') return decodeCurveBuyResult(raw);
      // The router returns nothing; ask the quoter for the same swap instead.
      return this.quote(route, token, amountInWei, from);
    } catch (error) {
      throw new Error(`simulated buy failed: ${describeRejection(error)}`);
    }
  }
}

function hex(n: bigint): string {
  return `0x${n.toString(16)}`;
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
  /** Rewards sitting in the mock escrow. */
  readonly claimable?: Raw;
  /** Token units received per wei at the first quote. */
  readonly tokensPerWei: bigint;
  /** Price impact per wei spent, in parts per 1e18. */
  readonly impactPer1e18?: bigint;
  readonly totalSupply: Raw;
  readonly gasUsed?: Raw;
  readonly gasPrice?: Raw;
  /** Force the executed price below the quote, to exercise slippage protection. */
  readonly executionDriftBps?: number;
  /** Pretend the token graduated to the v4 pool. */
  readonly graduated?: boolean;
  /** Pretend the token is not a Pons launch at all. */
  readonly unknownToken?: boolean;
}

const MOCK_CURVE = '0x5555555555555555555555555555555555555555' as Address;

export class MockChain implements Chain {
  readonly #o: Required<MockChainOptions>;
  #balance: Raw;
  #claimable: Raw;
  #block = 1_000_000;
  #burned = 0n;
  #sent = new Map<string, SwapReceipt>();
  readonly calls: string[] = [];

  constructor(options: MockChainOptions) {
    this.#o = {
      chainId: 0,
      claimable: 0n,
      impactPer1e18: 0n,
      gasUsed: 160_000n,
      gasPrice: 100_000_000n,
      executionDriftBps: 0,
      graduated: false,
      unknownToken: false,
      ...options,
    };
    this.#balance = options.balance;
    this.#claimable = this.#o.claimable;
  }

  get burned(): Raw {
    return this.#burned;
  }

  /** Simulates a reward landing in the escrow. */
  accrue(wei: Raw): void {
    this.#claimable += wei;
  }

  /** Simulates ETH arriving in the wallet directly. */
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

  async tokenTotalSupply(): Promise<Raw> {
    return this.#o.totalSupply;
  }

  async tokenBalance(_token: Address, owner: Address): Promise<Raw> {
    return owner.toLowerCase() === this.#o.burnAddress.toLowerCase() ? this.#burned : 0n;
  }

  async launch(token: Address): Promise<LaunchInfo> {
    this.calls.push(`launch:${token}`);
    if (this.#o.unknownToken) {
      return { token, exists: false, curve: NATIVE, deployer: NATIVE, creatorRecipient: NATIVE, pairToken: NATIVE, tickSpacing: 0, graduated: false, poolLiquidity: 0n };
    }
    return {
      token, exists: true, curve: MOCK_CURVE, deployer: this.#o.wallet, creatorRecipient: this.#o.wallet,
      pairToken: NATIVE, tickSpacing: 200, graduated: this.#o.graduated, poolLiquidity: this.#o.graduated ? 10n ** 21n : 0n,
    };
  }

  async claimable(wallet: Address): Promise<Raw> {
    this.calls.push(`claimable:${wallet}`);
    return wallet.toLowerCase() === this.#o.wallet.toLowerCase() ? this.#claimable : 0n;
  }

  async claim(): Promise<string> {
    this.calls.push(`claim:${this.#claimable}`);
    if (this.#claimable === 0n) throw new SwapRejectedError('execution reverted (fee escrow: nothing to claim)');
    const gasCost = 42_000n * this.#o.gasPrice;
    const hash = this.#hash();
    this.#block += 1;
    this.#balance += this.#claimable - gasCost;
    this.#claimable = 0n;
    this.#sent.set(hash, { txHash: hash, status: 'success', block: this.#block, timestamp: 1_760_000_000 + this.#block, gasUsed: 42_000n, effectiveGasPrice: this.#o.gasPrice, tokensToBurn: 0n });
    return hash;
  }

  async quote(route: Route, _token: Address, amountInWei: Raw): Promise<Raw> {
    this.calls.push(`quote:${route.kind}:${amountInWei}`);
    return this.#priceOut(amountInWei);
  }

  async swapToBurn(params: SwapToBurnParams): Promise<string> {
    this.calls.push(`swap:${params.route.kind}:${params.amountInWei}:${params.to}`);
    if (params.to.toLowerCase() !== this.#o.burnAddress.toLowerCase()) {
      throw new Error(`mock chain: swap recipient ${params.to} is not the burn address`);
    }
    if (params.amountInWei > this.#balance) throw new Error('mock chain: insufficient balance');

    const gasCost = this.#o.gasUsed * this.#o.gasPrice;
    const out = (this.#priceOut(params.amountInWei) * BigInt(10_000 - this.#o.executionDriftBps)) / 10_000n;
    const hash = this.#hash();
    this.#block += 1;

    if (out < params.amountOutMin) {
      // A real venue reverts and the value is returned; only gas is lost.
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

  async txReceipt(txHash: string): Promise<TxReceipt> {
    return this.receipt(txHash);
  }

  #hash(): string {
    return `0x${(this.#sent.size + 1).toString(16).padStart(64, '0')}`;
  }

  #priceOut(amountInWei: Raw): Raw {
    const linear = amountInWei * this.#o.tokensPerWei;
    // Constant-product-ish impact: out shrinks with size.
    const impact = (linear * this.#o.impactPer1e18 * amountInWei) / (10n ** 36n);
    return linear - impact;
  }
}
