/**
 * Pons on Robinhood Chain: the contracts, the calls, and the calldata.
 *
 * Every address and every function here was checked against Robinhood Chain
 * mainnet (chain id 4663) by simulation before it was written down:
 *
 *   - fee escrow      balanceOf(creator) is the claimable ETH; claim() pays it
 *                     to msg.sender and reverts (0xc2caa2a6) when it is zero.
 *   - factory         getLaunchedToken(token) returns the launch record whose
 *                     fields are decoded below; word 7 is the v4 tick spacing.
 *   - bonding curve   buy(amountIn, minOut, recipient) is payable, requires
 *                     msg.value == amountIn, returns the tokens delivered to
 *                     `recipient`, and reverts (0x71c4efed) under minOut.
 *   - Uniswap v4      after graduation the pool key is {ETH, token, fee 0,
 *                     tick spacing from the record, the Pons hook}; the V4
 *                     quoter's answer matched the Universal Router's fill to
 *                     the unit, and TAKE with amount 0 hands the whole output
 *                     to the recipient we name: the burn address.
 */

import { AbiCoder, Interface, concat, keccak256 } from 'ethers';
import { NATIVE, type Address, type LaunchInfo, type PoolKey, type Raw } from './types.js';

export const ROBINHOOD_CHAIN = {
  chainId: 4663,
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerTx: 'https://robinhoodchain.blockscout.com/tx/',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
} as const;

/** Pons v2 launch contracts (the current launcher). */
export const PONS = {
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address,
  hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' as Address,
  feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e' as Address,
} as const;

/** Uniswap v4 on Robinhood Chain. */
export const UNISWAP_V4 = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address,
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904' as Address,
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address,
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address,
} as const;

export const FEE_ESCROW_ABI = [
  'function balanceOf(address recipient) view returns (uint256)',
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claim()',
  'function claimToken(address token)',
];

export const FACTORY_ABI = ['function getLaunchedToken(address token) view returns (bytes)'];

export const CURVE_ABI = [
  'function buy(uint256 amountIn, uint256 minOut, address recipient) payable returns (uint256 amountOut)',
  'function graduated() view returns (bool)',
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'function getReserves() view returns (uint256 pairReserve, uint256 tokenReserve)',
];

export const STATE_VIEW_ABI = [
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

export const QUOTER_ABI = [
  'function quoteExactInputSingle((tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
];

export const UNIVERSAL_ROUTER_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];

export const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const coder = AbiCoder.defaultAbiCoder();
const factoryIface = new Interface(['function getLaunchedToken(address token)']);
const curveIface = new Interface(CURVE_ABI);
const routerIface = new Interface(UNIVERSAL_ROUTER_ABI);

/** Selectors, kept here so the CLI can name a revert. */
export const REVERTS: Record<string, string> = {
  '0xc2caa2a6': 'fee escrow: nothing to claim',
  '0x71c4efed': 'bonding curve: output below minOut',
  '0x8b063d73': 'Uniswap v4: output below minOut (V4TooLittleReceived)',
  '0xbc760cfe': 'bonding curve: msg.value does not match amountIn',
};

export function calldataForLaunchRecord(token: Address): string {
  return factoryIface.encodeFunctionData('getLaunchedToken', [token]);
}

/**
 * Decodes the factory's launch record from its raw return data.
 *
 * Layout observed on mainnet (15 words):
 *   0 token   1 curve   2 deployer   3 creator fee recipient   4 pair token
 *   5 graduation threshold   6 launch config id   7 tick spacing
 *   8..13 config / phase fields   14 exists flag
 */
export function decodeLaunchRecord(token: Address, raw: string): Omit<LaunchInfo, 'graduated' | 'poolLiquidity'> {
  const words = wordsOf(raw);
  if (words.length < 15) {
    return { token, exists: false, curve: NATIVE, deployer: NATIVE, creatorRecipient: NATIVE, pairToken: NATIVE, tickSpacing: 0 };
  }
  const addr = (i: number): Address => `0x${words[i]!.slice(24)}` as Address;
  const recorded = addr(0);
  const exists = words[14] !== '0'.repeat(64) && recorded.toLowerCase() === token.toLowerCase();
  return {
    token,
    exists,
    curve: addr(1),
    deployer: addr(2),
    creatorRecipient: addr(3),
    pairToken: addr(4),
    tickSpacing: Number(BigInt(`0x${words[7]!}`)),
  };
}

function wordsOf(hex: string): string[] {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: string[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

/** The v4 pool a Pons ETH-paired token graduates into. */
export function poolKeyFor(token: Address, tickSpacing: number, hook: Address = PONS.hook): PoolKey {
  const [currency0, currency1] = sortCurrencies(NATIVE, token);
  return { currency0, currency1, fee: 0, tickSpacing, hooks: hook };
}

export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

export function poolId(key: PoolKey): string {
  return keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

export interface V4SwapToBurn {
  readonly poolKey: PoolKey;
  readonly tokenOut: Address;
  readonly amountIn: Raw;
  readonly minOut: Raw;
  readonly recipient: Address;
  readonly deadline: number;
}

/** Universal Router action and command ids (v4-periphery `Actions`, universal-router `Commands`). */
const V4_SWAP = '0x10';
const SWAP_EXACT_IN_SINGLE = '0x06';
const SETTLE_ALL = '0x0c';
const TAKE = '0x0e';
const OPEN_DELTA = 0n;

/**
 * Calldata for `UniversalRouter.execute` that swaps exact ETH for the token
 * and hands the entire output to `recipient`. Send it with value = amountIn.
 */
export function encodeV4SwapToBurn(p: V4SwapToBurn): string {
  const zeroForOne = p.poolKey.currency0 === NATIVE;
  const tokenIn = zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1;
  if (tokenIn !== NATIVE) throw new Error('v4 route: the input currency must be native ETH');

  const swap = coder.encode(
    ['tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'],
    [{ poolKey: p.poolKey, zeroForOne, amountIn: p.amountIn, amountOutMinimum: p.minOut, hookData: '0x' }],
  );
  const settle = coder.encode(['address', 'uint256'], [NATIVE, p.amountIn]);
  const take = coder.encode(['address', 'address', 'uint256'], [p.tokenOut, p.recipient, OPEN_DELTA]);
  const actions = concat([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE]);
  const input = coder.encode(['bytes', 'bytes[]'], [actions, [swap, settle, take]]);
  return routerIface.encodeFunctionData('execute', [V4_SWAP, [input], p.deadline]);
}

/** Calldata for the bonding curve's `buy`. Send it with value = amountIn. */
export function encodeCurveBuy(amountIn: Raw, minOut: Raw, recipient: Address): string {
  return curveIface.encodeFunctionData('buy', [amountIn, minOut, recipient]);
}

export function decodeCurveBuyResult(raw: string): Raw {
  return BigInt(curveIface.decodeFunctionResult('buy', raw)[0] as bigint);
}

/** Names a custom-error revert when it is one we know. */
export function explainRevert(data: string | null | undefined): string | null {
  if (!data || data.length < 10) return null;
  return REVERTS[data.slice(0, 10)] ?? null;
}
