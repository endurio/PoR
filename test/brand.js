require('it-each')({ testPerIteration: true });
const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert, expectEvent, BN } = require('@openzeppelin/test-helpers');
const snapshot = require('./lib/snapshot');
const { keys, blocks, txs } = require('./data/por');
const utils = require('./lib/utils');
const { decShift } = require('../tools/lib/big');
const Web3 = require('web3')
const web3 = new Web3()

const ENDR = artifacts.require("ENDR");
const PoR = artifacts.require("PoR");
const RefNetwork = artifacts.require("RefNetwork");
const BrandMarket = artifacts.require("BrandMarket");
let inst;
let instPoR;
let instRN;
let instBM;

const FOOBAR = Buffer.from('foobar');
const FOOBAR_HEX = '0x'+FOOBAR.toString('hex');
const FOOBAR_HASH = web3.utils.keccak256(FOOBAR);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

contract("BrandMarket", accounts => {
  expect(accounts[0]).to.equal(keys[0].address, 'should the first keys data is the sender account');
  const sender = keys[0];

  before('should chain time be in the past', async () => {
    const chainTimestamp = Number(await time.latest())
    let oldestTimestamp // find the oldest block from the data
    for (const raw of Object.values(blocks)) {
      const block = bitcoinjs.Block.fromHex(raw)
      if (!oldestTimestamp || block.timestamp < oldestTimestamp) {
        oldestTimestamp = block.timestamp
      }
    }
    const oldest = moment.unix(oldestTimestamp)
    expect(chainTimestamp).to.be.at.most(oldestTimestamp,
      `relauch ganache with --time ${oldest.subtract(1, 'month').toISOString()}`)
  });

  before('should our contracts be deployed', async () => {
    inst = await ENDR.deployed();
    expect(inst, 'contract not deployed: ENDR').to.not.be.null
    // proxy implementations
    expect(await PoR.deployed(), 'contract not deployed: PoR').to.not.be.null
    instPoR = await PoR.at(inst.address)
    expect(await RefNetwork.deployed(), 'contract not deployed: RefNetwork').to.not.be.null
    instRN = await RefNetwork.at(inst.address)
    expect(await BrandMarket.deployed(), 'contract not deployed: BrandMarket').to.not.be.null
    instBM = await BrandMarket.at(inst.address)
  });

  before('should utils is properly initialized', async () => {
    await utils.initialize()
    expect(utils.inst, 'utils contract instances not initialized').to.not.be.null
  })

  describe('brand management', () => {
    it("mine some coin", async() => {
      const miner = await mineSomeCoin()
      expect(utils.addressCompare(miner.address, sender.address)).to.equal(0, "should the miner address is the truffle test account")
      const balance = await inst.balanceOf(sender.address)
      expect(balance).to.be.bignumber.equal(new BN(274882101312), "should some coin be mined")
    })

    it("activate new brand 'foobar'", async() => {
      const balance = 274882101312;
      const payRate = 0.1;
      await expectRevert(instBM.activate(FOOBAR, 0, decShift(payRate, 18), 0), '!fund')
      await expectRevert(instBM.activate(FOOBAR, 1, 0, 0), '!payRate')
      await expectRevert(instBM.activate(FOOBAR, balance+1, decShift(payRate, 18), 0), 'transfer amount exceeds balance')
      const receipt = await instBM.activate(FOOBAR, balance >> 1, decShift(payRate, 18), 0)
      expectEvent(receipt, 'Active', {
        memoHash: FOOBAR_HASH,
        payer: sender.address,
        memo: FOOBAR_HEX,
        payRate: decShift(payRate, 18),
        balance: (balance >> 1).toString(),
      })
      expectEvent(receipt, 'Transfer', {
        from: sender.address,
        to: inst.address,
        value: (balance >> 1).toString(),
      })
    })

    it("improve running brand 'foobar'", async() => {
      const balance = 274882101312;
      const payRate = 0.1;
      await expectRevert(instBM.activate(FOOBAR, 0, decShift(payRate, 18), 0), '!expired: increasing pay rate only')
      await expectRevert(instBM.activate(FOOBAR, 0, 0, 123), '!expired: extending expiration only')
      const receipt = await instBM.activate(FOOBAR, balance >> 2, decShift(payRate*2, 18), 0)
      expectEvent(receipt, 'Active', {
        memoHash: FOOBAR_HASH,
        payer: sender.address,
        memo: FOOBAR_HEX,
        payRate: decShift(payRate*2, 18),
        balance: ((balance>>1) + (balance>>2)).toString(),
      })
      expectEvent(receipt, 'Transfer', {
        from: sender.address,
        to: inst.address,
        value: (balance >> 2).toString(),
      })
    })

    it("de-activate a running brand", async() => {
      await expectRevert(instBM.deactivate(FOOBAR_HASH), '!expired')
    })

    it("re-activate an expired brand with lesser pay rate", async() => {
      await time.increase(2*7*24*60*60);  // default 2 weeks
      const payRate = 0.1/2;
      const receipt = await instBM.activate(FOOBAR, 123, decShift(payRate, 18), 0)
      expectEvent(receipt, 'Active', {
        memoHash: FOOBAR_HASH,
        payer: sender.address,
        memo: FOOBAR_HEX,
        payRate: decShift(payRate, 18),
      })
      expectEvent(receipt, 'Transfer', {
        from: sender.address,
        to: inst.address,
        value: '123',
      })
    })

    it("de-activate an expired brand", async() => {
      const {balance, expiration} = await instBM.getCampaignDetails(FOOBAR_HASH, sender.address)
      await time.increaseTo(expiration-30) // 30s before expired
      await expectRevert(instBM.deactivate(FOOBAR_HASH), '!expired')
      await time.increaseTo(expiration)    // just expired
      const receipt = await instBM.deactivate(FOOBAR_HASH)
      expectEvent(receipt, 'Deactive', {
        memoHash: FOOBAR_HASH,
        payer: sender.address,
      })
      expectEvent(receipt, 'Transfer', {
        from: inst.address,
        to: sender.address,
        value: balance,
      })
    })
  })

  describe('brand payment', () => {
    it("ready the chain time", async() => {
      const txHash = 'e79262b32f1514104ba1895ab881c62f11e355bd449d0918180dc86e2b184d09'
      const txData = txs[txHash]
      const block = bitcoinjs.Block.fromHex(blocks[txData.block]);
      await time.increaseTo(block.timestamp)
    })

    it("activate new brand 'foobar'", async() => {
      const fund = 200000000000;
      const payRate = 0.01;
      await instBM.activate(FOOBAR, fund, decShift(payRate, 18), 0)
    })

    it("mine the txs", async() => {
      const payRate = 0.01;
      const payer = sender.address;

      const commitTxs = [
        'e79262b32f1514104ba1895ab881c62f11e355bd449d0918180dc86e2b184d09',
        '73d229d9ca76efaf53d9fd1f361f054155d15b7d38244c9eaa2e292f6bc243f2',
      ]

      for (const txHash of commitTxs) {
        const {claimReceipt: receipt, miner} = await mine(txHash, payer)
        const recipient = miner.address
        const reward = utils.getExpectedReward(txs[txHash].block, payRate)
        const commission = reward / BigInt(2);
        expectEvent(receipt, 'CommissionLost', {
          payer,
          miner: recipient,
          value: commission.toString(),
        });
        expectEvent(receipt, 'Transfer', {
          from: inst.address,
          to: recipient,
          value: reward.toString(),
        });
        expectEvent(receipt, 'Reward', {
          memoHash: FOOBAR_HASH,
          payer,
          miner: recipient,
          value: reward.toString(),
        });
      }
    })

    // TODO: continue to mine until the brand's fund is exhausted and deactivated

    // TODO: active a brand with payRate * reward > fund, so the brand will be deactivated on the first payment

    // TODO: multiple campaigns of the same brand, and double claim tests
  })

  async function mineSomeCoin() {
    const {miner} = await mine('42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1')
    return miner
  }

  async function mine(txHash, brandPayer = ZERO_ADDRESS) {
    const txData = txs[txHash]
    const blockData = blocks[txData.block]
    const header = blockData.substring(0, 160)
    await instPoR.commitBlock('0x'+header)
    const {block, proofs, extra, vin, vout, memo} = utils.prepareCommitTx(txHash);
    const blockHash = block.getId();
    await instPoR.commitTx('0x' + blockHash, '0x' + proofs, '0x' + extra, '0x' + vin, '0x' + vout, brandPayer);
    await time.increaseTo(block.timestamp + 60*60)
    const miner = keys.find(k => k.address == txData.miner)
    await instPoR.registerMiner('0x'+miner.public, ZERO_ADDRESS) // register and set the recipient
    const memoHash = web3.utils.keccak256(Buffer.from(memo))
    const {state} = await instPoR.getWinner('0x'+blockHash, memoHash);
    switch (Number(state)) {
      case 0: throw "tx already claimed"
      case 1: var claimReceipt = await utils.claim(txData, memoHash); break;
      case 2: var claimReceipt = await utils.claimWithPrevTx(txData, memoHash); break;
      default: throw `unknown TxState: ${state}`
    }
    return {
      claimReceipt,
      miner,
    };
  }
})

