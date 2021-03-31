const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert, expectEvent, BN } = require('@openzeppelin/test-helpers');
const snapshot = require('./lib/snapshot');
const utils = require('./lib/utils');
const { decShift } = require('../tools/lib/big');
const Web3 = require('web3')
const web3 = new Web3()

const { keys, txs } = require('./data/all');
const blocks = utils.loadBlockData()

const Endurio = artifacts.require("Endurio");
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
    for (const hash of Object.keys(blocks)) {
      const block = utils.getBlock(hash)
      if (!oldestTimestamp || block.timestamp < oldestTimestamp) {
        oldestTimestamp = block.timestamp
      }
    }
    const oldest = moment.unix(oldestTimestamp)
    expect(chainTimestamp).to.be.at.most(oldestTimestamp,
      `relauch ganache with --time ${oldest.subtract(1, 'month').toISOString()}`)
  });

  before('should our contracts be deployed', async () => {
    inst = await Endurio.deployed();
    expect(inst, 'contract not deployed: Endurio').to.not.be.null
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
      expect(utils.addressCompare(miner, sender.address)).to.equal(0, "should the miner address is the truffle test account")
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
      const {balance, expiration} = await instBM.queryCampaign(FOOBAR_HASH, sender.address)
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

    const payRate = 0.001;

    it("activate new brand 'foobar'", async() => {
      const fund = 200000000000;
      await instBM.activate(FOOBAR, fund, decShift(payRate, 18), 0)
    })

    it("mine the txs", async() => {
      const payer = sender.address;

      const testingTxs = [
        'bc9168e6cedd9cc8d422892482ac4bd7e99cd2f90b97ef4f7695480e166d3b17',
        '8fc78e141b1e3ce488d4d06f387f4fb8a78f87b9b3949d7bfe2fb70d9a984444',
        '1bd88cab82b0f38e086d63142a7d00dfa35d15273054ccd887e796e44d53093c',
        'e7b9d9c81d0f5c2e15619dcfacccf9f961acdae549d58ef26b49574c7d041611',
        'f93b20c7c44774c6d54f473cb3b1a81c569145a87afcfc5db0410a23f7e0be54',
        '45502cf89a706abe375bc1adaa0952925c435f3e3d8a1aedc668d2203e9c2fc0',
      ]

      for (const txHash of testingTxs) {
        const receipt = await mine(txHash, payer)
        const miner = txs[txHash].miner
        const reward = utils.getExpectedReward(txHash, payRate).bounty
        const commission = reward / BigInt(2);
        expectEvent(receipt, 'CommissionLost', {
          payer,
          miner,
          value: commission.toString(),
        });
        expectEvent(receipt, 'Transfer', {
          from: inst.address,
          to: miner,
          value: reward.toString(),
        });
        expectEvent(receipt, 'Claim', {
          memoHash: FOOBAR_HASH,
          payer,
          miner,
          value: reward.toString(),
        });
      }
    })

    // TODO: continue to mine until the brand's fund is exhausted and deactivated

    // TODO: active a brand with payRate * reward > fund, so the brand will be deactivated on the first payment

    // TODO: multiple campaigns of the same brand, and double claim tests
  })

  async function mineSomeCoin() {
    const txHash = '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1'
    await mine(txHash)
    return txs[txHash].miner
  }

  async function mine(txHash, payer) {
    const submitReceipt = await utils.submitTx(txHash, payer)
    await utils.timeToClaim(txHash)
    return await utils.claim(submitReceipt)
  }
})

