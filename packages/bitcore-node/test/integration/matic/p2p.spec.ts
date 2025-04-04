import * as BitcoreClient from 'bitcore-client';
import { expect } from 'chai';
import { Web3, Transactions } from 'crypto-wallet-core';
import sinon from 'sinon';
import config from '../../../src/config';
import { CacheStorage } from '../../../src/models/cache';
import { EVMBlockStorage } from '../../../src/providers/chain-state/evm/models/block';
import { EVMP2pWorker } from '../../../src/providers/chain-state/evm/p2p/p2p';
import { Api } from '../../../src/services/api';
import { IEVMNetworkConfig } from '../../../src/types/Config';
import { wait } from '../../../src/utils';
import { resetDatabase } from '../../helpers';
import { intAfterHelper, intBeforeHelper } from '../../helpers/integration';

const { StreamUtil } = BitcoreClient;
const chain = 'MATIC';
const network = 'regtest';
const chainConfig = config.chains[chain][network] as IEVMNetworkConfig;
const name = 'PolygonWallet-Ci';
const storageType = 'Level';
const baseUrl = 'http://localhost:3000/api';
const password = '';
const phrase = 'glimpse mystery poverty onion muffin twist live kidney unhappy sort frame muffin';
const accounts = { geth: '0xeC12CD1Ab86F83C1B26C5caa38126Bc4299b6CBa' };
const privKeys = { geth: '0xf9ad2207e910cd649c9a32063dea3656380c32fa07d6bb9be853687ca585a015' };

async function getWallet() {
  let wallet: BitcoreClient.Wallet;
  try {
    wallet = await BitcoreClient.Wallet.loadWallet({ name, storageType });
    await wallet.register();
    await wallet.syncAddresses();
    return wallet;
  } catch (e) {
    console.log('Creating a new matic wallet');
    wallet = await BitcoreClient.Wallet.create({
      name,
      chain,
      network,
      baseUrl,
      password,
      phrase,
      storageType
    });
    await wallet.unlock(password);
    await wallet.nextAddressPair();
    await wallet.lock();
    return wallet;
  }
}

async function sendTransaction(from, to, amount, web3, wallet, nonce = 0) {
  if (!wallet) {
    wallet = await getWallet();
  }
  if (!nonce) {
    nonce = await web3.eth.getTransactionCount(accounts[from]);
  }
  const gasPrice = Number(await web3.eth.getGasPrice());
  const tx = await wallet.newTx({ recipients: [{ address: to, amount }], from: accounts[from], nonce, gasLimit: 21000, gasPrice });
  const signedTx = await wallet.signTx({ tx, signingKeys: [{ privKey: privKeys[from] }] });
  await web3.eth.sendSignedTransaction(signedTx);
}

describe('Polygon', function() {
  const suite = this;
  this.timeout(50000);
  const sandbox = sinon.createSandbox();

  before(async () => {
    await intBeforeHelper();
    await resetDatabase();
    await Api.start();
    sandbox.stub(Transactions.get({ chain }), 'getChainId').returns(1337);
  });

  after(async () => {
    await Api.stop();
    await intAfterHelper(suite);
    sandbox.restore();
  });

  it('should be able to create a wallet with an address', async () => {
    const wallet = await getWallet();
    const addresses = await wallet.getAddresses();
    expect(addresses).to.exist;
    expect(addresses.length).to.eq(1);
    expect(addresses[0].toLowerCase()).to.equal('0xa4e131d8c33fc059e9d245489db03a4a61a2f32b');
  });

  it('should be able to get block events from geth', async () => {
    const gethOnlyConfig = { ...chainConfig, provider: chainConfig.providers![0] };
    const { protocol, host, port } = gethOnlyConfig.provider;
    const getWeb3Stub = sinon.stub(EVMP2pWorker.prototype, 'getWeb3').resolves({ web3: new Web3(`${protocol}://${host}:${port}`) });

    const wallet = await getWallet();
    const addresses = await wallet.getAddresses();

    const worker = new EVMP2pWorker({ chain, network, chainConfig: gethOnlyConfig });
    await worker.setupListeners();
    await worker.connect();
    const sawBlock = new Promise(resolve => worker.events.on('block', resolve));

    const { web3 } = await worker.getWeb3();
    const nonce = await web3.eth.getTransactionCount(accounts['geth']);
    // sending multiple tx to entice geth to mine a block because sometimes it doesn't mine even with automine enabled
    sendTransaction('geth', addresses[0], web3.utils.toWei('.01', 'ether'), web3, wallet, nonce),
    sendTransaction('geth', addresses[0], web3.utils.toWei('.01', 'ether'), web3, wallet, nonce + 1)
    await sawBlock;
    await worker.disconnect();
    await worker.stop();
    getWeb3Stub.restore();
  });

  it('should be able to get the balance for the address', async () => {
    const wallet = await getWallet();
    const balance = await wallet.getBalance({ hex: true });
    expect(Number(balance.confirmed)).to.be.gt(0);

    const key = 'getBalanceForAddress-MATIC-regtest-0xa4e131d8c33fc059e9d245489db03a4a61a2f32b';
    const cached = await CacheStorage.collection.findOne({ key });
    expect(cached).to.exist;
    expect(cached!.value).to.deep.eq(balance);
    await wallet.lock();
  });

  it('should update after a send', async () => {
    const wallet = await getWallet();
    const addresses = await wallet.getAddresses();
    const beforeBalance = await wallet.getBalance();

    const worker = new EVMP2pWorker({ chain, network, chainConfig });
    await worker.setupListeners();
    await worker.connect();
    const sawBlock = new Promise(resolve => worker.events.on('block', resolve));

    const { web3 } = await worker.getWeb3();
    await sendTransaction('geth', addresses[0], web3.utils.toWei('.01', 'ether'), web3, wallet);
    await sawBlock;
    await worker.disconnect();
    await worker.stop();
    const afterBalance = await wallet.getBalance();
    expect(afterBalance).to.not.deep.eq(beforeBalance);
    expect(afterBalance.confirmed).to.be.gt(beforeBalance.confirmed);
    await wallet.lock();
  });

  it('should have receipts on tx history', async () => {
    const wallet = await getWallet();
    await new Promise<void>(r =>
      wallet
        .listTransactions({})
        .pipe(StreamUtil.jsonlBufferToObjectMode())
        .on('data', (tx: any) => {
          if (tx.height >= 0) {
            expect(tx.receipt).to.exist;
            expect(tx.receipt.gasUsed).to.exist;
            expect(tx.receipt.gasUsed).to.be.lte(tx.gasLimit);
            expect(tx.fee).to.eq(tx.gasPrice * tx.receipt.gasUsed);
          }
        })
        .on('finish', () => {
          r();
        })
    );

    await wallet.lock();
  });

  it.skip('should be able to save blocks to the database', async () => {
    const wallet = await getWallet();
    const addresses = await wallet.getAddresses();

    const worker = new EVMP2pWorker({ chain, network, chainConfig });
    const done = worker.syncDone();
    const sawBlock = new Promise(resolve => worker.events.on('block', resolve));
    await worker.start();
    await wait(1000);

    const { web3 } = await worker.getWeb3();
    await sendTransaction('geth', addresses[0], web3.utils.toWei('.02', 'ether'), web3, wallet);
    await sawBlock;
    await done;
    await worker.stop();

    const dbBlocks = await EVMBlockStorage.collection.count({ chain, network });
    expect(dbBlocks).to.be.gt(0);
    await wallet.lock();
  });

  it('should be able to handle reorgs');
  it('should be able to handle a failed getBlock');

  it('should be able to get tx events from parity');
  it('should be able to save transactions to the database');
});
