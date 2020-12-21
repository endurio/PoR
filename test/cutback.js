require('it-each')({ testPerIteration: true });
const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert, expectEvent, BN } = require('@openzeppelin/test-helpers');
const snapshot = require('./lib/snapshot');
const utils = require('./lib/utils');
const colors = require('colors');
const { decShift } = require('../tools/lib/big');
const Web3 = require('web3')
const web3 = new Web3()

const { keys, txs } = require('./data/all');
const { ZERO_BYTES32 } = require('@openzeppelin/test-helpers/src/constants');
const { claim } = require('./lib/utils');
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
const DUMMY_ADDRESS = '0x1234567890123456789012345678901234567890';

const HIGHEST_ONE = '0x8000000000000000000000000000000000000000000000000000000000000000'

contract("RefNetwork: CutBack", accounts => {
  const acc1 = accounts[accounts.length-1]
  const acc2 = accounts[accounts.length-2]
  const acc3 = accounts[accounts.length-3]
  const acc4 = accounts[accounts.length-4]

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

  const commitTxs = [
    '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
    'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
    '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
    '9da4809c20689edf1874a47f8b9c60adbcd888400eb46b368cd21cdbe2517e5d',
    '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
    '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
  ]
  const commitReceipts = {}
  const miners = []
  commitTxs.forEach(txHash => {
    const miner = txs[txHash].miner
    if (!miners.includes(miner)) {
      miners.push(miner)
    }
  })

  before('commit all txs', async () => {
    for (const txHash of commitTxs) {
      commitReceipts[txHash] = await utils.commitTx(txHash);
    }
  })

  before('mine some coin and fund all accounts', async () => {
    const miner = await mineSomeCoin()
    const balance = await inst.balanceOf(miner)
    expect(balance).to.be.bignumber.equal(new BN(1054043766919), "should some coin be mined")
    for (const acc of accounts) {
      await inst.transfer(acc, 100+'0'.repeat(9), {from: miner});
    }
  })

  describe('sandbox', () => {

    it("commission native cut back", async() => {
      const ss = await snapshot.take()
      const txHash = '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a'
      await utils.timeToClaim(commitTxs[commitTxs.length-1])

      const miner = txs[txHash].miner
      await instRN.attach(acc4, {from: miner});
  
      await instRN.setRent(decShift(10, 9), {from: acc4})
      await instRN.deposit(100000000000, {from: acc4})

      { // snapshot scope
        const ss = await snapshot.take()
        const cutbackRate = 0
        await instRN.setCutbackRate(ZERO_ADDRESS, decShift(cutbackRate, 9), 0, {from: acc4})
        await claimWithCommission(txHash, cutbackRate)
        await snapshot.revert(ss)
      }
      { // snapshot scope
        const ss = await snapshot.take()
        const cutbackRate = 1.0
        await instRN.setCutbackRate(ZERO_ADDRESS, decShift(cutbackRate, 9), 0, {from: acc4})
        await claimWithCommission(txHash, cutbackRate)
        await snapshot.revert(ss)
      }

      const cutbackRate = 0.613
      await instRN.setCutbackRate(ZERO_ADDRESS, decShift(cutbackRate, 9), 0, {from: acc4})
      await claimWithCommission(txHash, cutbackRate)
      await snapshot.revert(ss)
    })

    it("commission token cut back", async() => {
      const ss = await snapshot.take()
      const txHash = '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a'
      await utils.timeToClaim(commitTxs[commitTxs.length-1])

      const miner = txs[txHash].miner
      await instRN.attach(acc4, {from: miner});
  
      await instRN.setRent(decShift(10, 9), {from: acc4})
      await instRN.deposit(100000000000, {from: acc4})

      // abuse the END as the cutback token
      const tokenAddress = inst.address
      const commitReceipt = commitReceipts[txHash]

      { // snapshot scope
        const ss = await snapshot.take()
        await instRN.setCutbackRate(DUMMY_ADDRESS, 1, 0, {from: acc4})
        await expectRevert(utils.claim(commitReceipt), 'revert')
        const params = utils.paramsToClaim(commitReceipt)
        params.skipCommission = true
        const claimReceipt = await instPoR.claim(params, {from: miner})
        expectEvent(claimReceipt, 'CommissionSkip', { miner })
        const cutbackLog = claimReceipt.logs.find(log => log.event === 'Transfer' && log.args.from == acc4 && log.args.to == miner)
        expect(cutbackLog).to.be.undefined
        await snapshot.revert(ss)
      }

      { // snapshot scope
        const ss = await snapshot.take()
        await instRN.setCutbackRate(tokenAddress, 0, 0, {from: acc4})
        await claimWithCommission(txHash, 0)
        await snapshot.revert(ss)
      }

      { // snapshot scope
        const ss = await snapshot.take()
        await instRN.setCutbackRate(tokenAddress, 1, 0, {from: acc4})

        await expectRevert(utils.claim(commitReceipt), 'transfer amount exceeds allowance')
        await inst.approve(inst.address, 123456798, {from: acc4});
        await expectRevert(utils.claim(commitReceipt), 'transfer amount exceeds allowance')

        await inst.approve(inst.address, HIGHEST_ONE, {from: acc4});
        await claimWithCommission(txHash, 1)

        await snapshot.revert(ss)
      }

      await inst.approve(inst.address, HIGHEST_ONE, {from: acc4});
      await instRN.setCutbackRate(tokenAddress, 613, 2, {from: acc4})
      await expectRevert(utils.claim(commitReceipt), 'transfer amount exceeds balance')
      await instRN.setCutbackRate(tokenAddress, 613, 4, {from: acc4})
      await claimWithCommission(txHash, 0.0613)
      await snapshot.revert(ss)
    })

    it("commission skipping self cut back", async() => {
      const ss = await snapshot.take()
      const txHash = '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a'
      await utils.timeToClaim(commitTxs[commitTxs.length-1])

      const miner = txs[txHash].miner
      await instRN.setRent(decShift(10, 9), {from: miner})
      await instRN.deposit(100000000000, {from: miner})

      const cutbackRate = 0.613
      await instRN.setCutbackRate(ZERO_ADDRESS, decShift(cutbackRate, 9), 0, {from: miner})
      // self cut-back expect no transfer
      await claimWithCommission(txHash)
      await snapshot.revert(ss)
    })

    async function claimWithCommission(txHash, cutbackRate) {
      const comRate = (await inst.getGlobalConfig()).comRate
      const miner = txs[txHash].miner
      const commitReceipt = commitReceipts[txHash]
      const claimReceipt = await utils.claim(commitReceipt)
      const rewarded = claimReceipt.logs.find(log => log.event === 'Rewarded').args.value
      const value = rewarded.mul(comRate).div(new BN(1e9))
      const com = claimReceipt.logs.find(log => log.event === 'CommissionPaid')
      if (!com) {
        expectEvent(claimReceipt, 'CommissionLost', { miner, value })
        return
      }
      const payee = com.args.payee
      expectEvent(claimReceipt, 'CommissionPaid', { miner, payee, value })
      const cutbackLog = claimReceipt.logs.find(log => log.event === 'Transfer' && log.args.from == payee && log.args.to == miner)
      if (!cutbackRate) {
        expect(cutbackLog).to.be.undefined
        return
      }
      expect(cutbackLog).to.be.not.undefined
      const cutback = value.mul(new BN(decShift(cutbackRate, 9))).div(new BN(1000000000))
      const cutbackValue = cutbackLog.args.value
      expect(cutbackValue).is.bignumber.equal(cutback)
    }
  })

  async function mineSomeCoin() {
    const txHash = 'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c'
    await mine(txHash)
    return txs[txHash].miner
  }

  async function mine(txHash, payer) {
    const commitReceipt = await utils.commitTx(txHash, payer)
    await utils.timeToClaim(txHash)
    return await utils.claim(commitReceipt)
  }
})

