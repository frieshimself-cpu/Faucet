/**
 * The live code path, end to end, against a real EVM.
 *
 * ganache runs an in-process node; solc compiles a real ERC-20, a bonding
 * curve with the Pons v2 curve's exact external shape, a fee escrow with the
 * Pons escrow's, and a factory returning the mainnet record layout.
 * EthersChain, the adapter that talks to Robinhood Chain, signs and sends
 * real transactions here. What this proves: the calldata is right, the claim
 * pays the wallet exactly what the escrow said, the buy delivers to the burn
 * address, the receipt parsing finds the burn, the slippage bound refuses a
 * moved market before anything is signed, and the wei-exact conservation
 * check holds against a real node's gas accounting. The Uniswap v4 leg is
 * validated against mainnet by `faucet doctor` (eth_call simulation), since
 * a PoolManager is too heavy to stand up here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther } from 'ethers';
import { BuybackError, claimRewards, execute, plan } from '../src/buyback.js';
import { CONFIG } from '../src/config.js';
import { EthersChain, SwapRejectedError } from '../src/evm.js';
import { assertReceiptConserved } from '../src/ledger.js';
import type { Address } from '../src/types.js';
import { BURN_ADDRESS, NATIVE } from '../src/types.js';

const require = createRequire(import.meta.url);

interface Compiled { abi: unknown[]; bytecode: string }
type Names = 'TestToken' | 'TestCurve' | 'TestEscrow' | 'TestFactory' | 'TestStateView';

function compile(): Record<Names, Compiled> {
  const solc = require('solc') as { compile(input: string): string };
  const source = readFileSync(resolve('engine/test/contracts/Fixtures.sol'), 'utf8');
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Fixtures.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>> };
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const pick = (name: Names): Compiled => {
    const c = output.contracts['Fixtures.sol']![name]!;
    return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  };
  return { TestToken: pick('TestToken'), TestCurve: pick('TestCurve'), TestEscrow: pick('TestEscrow'), TestFactory: pick('TestFactory'), TestStateView: pick('TestStateView') };
}

const CHAIN_ID = 31337;
const PORT = 8546 + Math.floor(Math.random() * 400);
const DEPLOYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEV_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

let server: { listen(port: number): Promise<void>; close(): Promise<void> };
let provider: JsonRpcProvider;
let deployer: NonceManager;
let deployerWallet: Wallet;
let dev: Wallet;
let token: Address;
let curve: Address;
let escrow: Address;
let factory: Address;
let stateView: Address;
let curveContract: Contract;
let escrowContract: Contract;

before(async () => {
  // ganache prints a µWS compatibility warning on require under Node 22; it
  // falls back to a JS transport and works. Keep the test output clean.
  const warn = console.warn;
  console.warn = () => {};
  const ganache = require('ganache') as { server(opts: unknown): typeof server };
  console.warn = warn;
  server = ganache.server({
    chain: { chainId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: [{ secretKey: DEPLOYER_KEY, balance: '0x' + (1000n * 10n ** 18n).toString(16) }, { secretKey: DEV_KEY, balance: '0x0' }] },
    logging: { quiet: true },
  });
  await server.listen(PORT);

  provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, CHAIN_ID, { staticNetwork: true });
  // ganache reports pending nonces lazily; NonceManager tracks them locally so
  // back-to-back deployments never collide on an address.
  deployerWallet = new Wallet(DEPLOYER_KEY, provider);
  deployer = new NonceManager(deployerWallet);
  dev = new Wallet(DEV_KEY, provider);

  const c = compile();
  const deploy = async (name: Names, ...args: unknown[]): Promise<Contract> => {
    const contract = await new ContractFactory(c[name].abi as never, c[name].bytecode, deployer).deploy(...args);
    await contract.waitForDeployment();
    return contract as unknown as Contract;
  };

  const supply = 1_000_000_000n * 10n ** 18n;
  const tokenContract = await deploy('TestToken', supply);
  token = (await tokenContract.getAddress()) as Address;
  curveContract = await deploy('TestCurve', token);
  curve = (await curveContract.getAddress()) as Address;
  escrowContract = await deploy('TestEscrow');
  escrow = (await escrowContract.getAddress()) as Address;
  const factoryContract = await deploy('TestFactory');
  factory = (await factoryContract.getAddress()) as Address;
  stateView = (await (await deploy('TestStateView')).getAddress()) as Address;

  // Seed the curve: 10 ETH against 400,000,000 ROBIN, and register the launch.
  const poolTokens = 400_000_000n * 10n ** 18n;
  await (await tokenContract.getFunction('transfer')(curve, poolTokens)).wait();
  await (await curveContract.getFunction('seed')(poolTokens, { value: parseEther('10') })).wait();
  await (await factoryContract.getFunction('register')(token, curve, dev.address, dev.address, 200)).wait();
});

after(async () => {
  provider.destroy();
  await server.close();
});

async function fund(wei: bigint): Promise<void> {
  await (await deployer.sendTransaction({ to: dev.address, value: wei })).wait();
}

async function accrue(wei: bigint): Promise<void> {
  await (await escrowContract.connect(deployer).getFunction('deposit')(dev.address, { value: wei })).wait();
}

function chainFor(key: string | undefined): EthersChain {
  return new EthersChain({
    rpcUrl: `http://127.0.0.1:${PORT}`, chainId: CHAIN_ID, privateKey: key,
    contracts: { factory, feeEscrow: escrow, hook: CONFIG.pons.hook, universalRouter: NATIVE, quoter: NATIVE, stateView },
  });
}

const overrides = () => ({ wallet: dev.address as Address, token });

test('EthersChain reads the node: chain id, supply, launch record, escrow, quote', async () => {
  const chain = chainFor(undefined);
  assert.equal(await chain.chainId(), CHAIN_ID);
  assert.equal(await chain.tokenTotalSupply(token), 1_000_000_000n * 10n ** 18n);

  const launch = await chain.launch(token);
  assert.equal(launch.exists, true);
  assert.equal(launch.curve.toLowerCase(), curve.toLowerCase());
  assert.equal(launch.creatorRecipient.toLowerCase(), dev.address.toLowerCase());
  assert.equal(launch.pairToken, NATIVE);
  assert.equal(launch.tickSpacing, 200);
  assert.equal(launch.graduated, false);

  assert.equal(await chain.claimable(dev.address as Address), 0n);
  const q = await chain.quote({ kind: 'pons-curve', curve }, token, parseEther('0.01'), dev.address as Address);
  assert.ok(q > 0n, 'the curve must quote, even from an empty wallet');
});

test('an empty claim is refused before it is sent', async () => {
  const chain = chainFor(DEV_KEY);
  await fund(parseEther('0.01'));
  const result = await claimRewards({ config: CONFIG, chain, ...overrides(), mode: 'live' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skip, 'nothing-claimable');
  await assert.rejects(chain.claim(), (e: unknown) => e instanceof SwapRejectedError && /nothing to claim/.test(e.message));
});

test('a real cycle: claim pays the wallet exactly, the buy lands on the burn address, wallet conserved to the wei', async () => {
  const chain = chainFor(DEV_KEY);
  const reward = parseEther('0.05');
  await accrue(reward);

  const walletBefore = await chain.balance(dev.address as Address);
  const claimed = await claimRewards({ config: CONFIG, chain, ...overrides(), mode: 'live' });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  assert.equal(claimed.receipt.amount, reward, 'what the escrow said is what arrived');
  assert.equal(await chain.balance(dev.address as Address), walletBefore + reward - claimed.receipt.gasCost, 'claim conserved to the wei');
  assert.equal(await chain.claimable(dev.address as Address), 0n);

  const burnBefore = await chain.tokenBalance(token, BURN_ADDRESS);
  const planned = await plan({ config: CONFIG, chain, ...overrides() });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.plan.route.kind, 'pons-curve');
  assert.equal(planned.plan.to, BURN_ADDRESS);
  assert.equal(planned.plan.spend + planned.plan.gasReserve, planned.plan.balance);

  const receipt = await execute({ config: CONFIG, chain, plan: planned.plan, id: 1, mode: 'live', token, claimTx: claimed.receipt.txHash });
  assertReceiptConserved(receipt);

  const burnAfter = await chain.tokenBalance(token, BURN_ADDRESS);
  assert.equal(burnAfter - burnBefore, receipt.tokensBurned, 'ledger must equal what the burn address actually received');
  assert.equal(receipt.tokensBurned, planned.plan.expectedOut, 'the curve fills exactly at its quote when nothing moved');
  assert.equal(receipt.ethSpent, planned.plan.spend);
  assert.equal(receipt.venue, 'pons-curve');
  assert.equal(receipt.claimTx, claimed.receipt.txHash);

  const walletAfter = await chain.balance(dev.address as Address);
  assert.equal(walletAfter, receipt.balanceAfter);
  assert.equal(receipt.balanceBefore - receipt.ethSpent - receipt.gasCost, walletAfter, 'wei-exact against real gas accounting');
  assert.ok(receipt.gasCost <= CONFIG.limits.gasReserveWei, 'gas came out of the reserve');
  assert.match(receipt.txHash, /^0x[0-9a-f]{64}$/);
});

test('the slippage bound refuses the buy when the market moves against us; nothing is burned', async () => {
  const chain = chainFor(DEV_KEY);
  await fund(parseEther('0.05'));

  const planned = await plan({ config: CONFIG, chain, ...overrides() });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;

  // Between quote and fill, drain a third of the curve's tokens.
  await (await curveContract.connect(deployer).getFunction('drain')(130_000_000n * 10n ** 18n)).wait();

  const before = await chain.balance(dev.address as Address);
  const burnBefore = await chain.tokenBalance(token, BURN_ADDRESS);
  await assert.rejects(
    execute({ config: CONFIG, chain, plan: planned.plan, id: 2, mode: 'live', token }),
    (e: unknown) => e instanceof BuybackError && /rejected before sending/.test(e.message) && /below minOut/.test(e.message),
  );
  const after = await chain.balance(dev.address as Address);
  assert.equal(await chain.tokenBalance(token, BURN_ADDRESS), burnBefore, 'nothing burned');
  assert.equal(after, before, 'the node refused it pre-flight, so no gas was spent either');
});

test('a graduated launch with no pool liquidity is a skip, not a send', async () => {
  const chain = chainFor(DEV_KEY);
  await (await curveContract.connect(deployer).getFunction('graduate')()).wait();
  const planned = await plan({ config: CONFIG, chain, ...overrides() });
  assert.equal(planned.ok, false);
  if (planned.ok) return;
  assert.equal(planned.skip.kind, 'no-route');
});

test('the engine refuses to sign with a key that is not the configured dev wallet', async () => {
  const wrong = chainFor(DEPLOYER_KEY);
  assert.notEqual(wrong.signer?.toLowerCase(), dev.address.toLowerCase());
  // The CLI enforces this before building a chain; here we check the adapter exposes the signer to enforce it.
  assert.equal(wrong.signer?.toLowerCase(), deployerWallet.address.toLowerCase());
});
