require('it-each')({ testPerIteration: true });
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

contract("RefNetwork", accounts => {
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

  before('mine some coin and fund the noder', async () => {
    const miner = await mineSomeCoin()
    const balance = await inst.balanceOf(miner)
    expect(balance).to.be.bignumber.equal(new BN(1054043766919), "should some coin be mined")
    await inst.transfer(acc1, 100+'0'.repeat(9), {from: miner});
    await inst.transfer(acc2, 200+'0'.repeat(9), {from: miner});
    await inst.transfer(acc3, 300+'0'.repeat(9), {from: miner});
    await inst.transfer(acc4, 400+'0'.repeat(9), {from: miner});
  })

  describe('node management', () => {
    it("self reference", async() => {
      await expectRevert(instRN.attach(acc2, {from: acc2}), 'circular reference')
    })

    it("circular reference", async() => {
      await instRN.attach(acc3, {from: acc4})
      await expectRevert(instRN.attach(acc4, {from: acc3}), 'circular reference')
      await instRN.attach(acc2, {from: acc3})
      await expectRevert(instRN.attach(acc4, {from: acc2}), 'circular reference')
      await instRN.attach(acc1, {from: acc2})
      await expectRevert(instRN.attach(acc4, {from: acc1}), 'circular reference')
      await expectRevert(instRN.attach(acc3, {from: acc1}), 'circular reference')
      await expectRevert(instRN.attach(acc2, {from: acc1}), 'circular reference')
      await instRN.attach(acc2, {from: acc4})
      await instRN.attach(acc4, {from: acc3})
      await expectRevert(instRN.attach(acc3, {from: acc1}), 'circular reference')
      await expectRevert(instRN.attach(acc2, {from: acc2}), 'circular reference')
    })
  })

  describe('sandbox', () => {
    it("over deposit with rent = 1", async() => {
      const ss = await snapshot.take()
      await instRN.setRent(1, {from: acc4})
      if (true) {
        await expectRevert(instRN.deposit(400+'0'.repeat(8)+'1', {from: acc4}), 'exceeds balance')
      } else {  // remove the _burn line in RefNetwork.deposit to test this block
        await instRN.setRent(1, {from: acc4})
        await expectRevert(instRN.deposit('115792089237316195423570985008687907853269984665640564039457584007913129639935', {from: acc4}), 'addition overflow')
        await expectRevert(instRN.deposit('18446744073709551615', {from: acc4}), 'expiration overflow ui64')
        await instRN.setRent(2, {from: acc4})
        await instRN.deposit('18446744073709551615', {from: acc4})
      }
      await snapshot.revert(ss)
    })

    it("exact deposit and withdraw with rent = 1", async() => {
      const ss = await snapshot.take()
      await instRN.setRent(1, {from: acc4})
      expectEvent(await instRN.deposit('613', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '613' })
      expectEvent(await instRN.deposit('13', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '13' })
      await expectRevert(instRN.withdraw(0, {from: acc4}), '!amount')
      expectEvent(await instRN.withdraw('136', {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '136' })
      {
        const receipt = await instRN.withdraw('490', {from: acc4})
        expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
        expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('490')
      }
      await expectRevert(instRN.withdraw(1, {from: acc4}), 'expired')
      await snapshot.revert(ss)
    })

    it("truncated deposit with rent > 1", async() => {
      const ss = await snapshot.take()
      await instRN.setRent(13, {from: acc4})
      expectEvent(await instRN.deposit('130', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '130' })
      expectEvent(await instRN.deposit('136', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '130' })
      await expectRevert(instRN.withdraw(0, {from: acc4}), '!amount')
      await expectRevert(instRN.withdraw(12, {from: acc4}), '!duration')
      expectEvent(await instRN.withdraw('14', {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '13' })
      expectEvent(await instRN.withdraw('40', {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '39' })
      {
        const receipt = await instRN.withdraw('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', {from: acc4})
        expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
        expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('208')
      }
      await expectRevert(instRN.withdraw(13, {from: acc4}), 'expired')
      await snapshot.revert(ss)
    })

    it("rent half paid", async() => {
      const ss = await snapshot.take()
      await instRN.setRent(613, {from: acc4})
      expectEvent(await instRN.deposit('61300', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '61300' })  // +100s
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(50) // -50s
        // withdraw the rest of 50s
        {
          const receipt = await instRN.withdraw(30650+613, {from: acc4})
          expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
          expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('30650')
        }
        await expectRevert(instRN.withdraw(613, {from: acc4}), 'expired')
        await snapshot.revert(ss)
      }
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(50) // -50s
        expectEvent(await instRN.withdraw(18390, {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '18390' })
        {
          const receipt = await instRN.withdraw(12260, {from: acc4})
          expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
          expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('12260')
        }
        await expectRevert(instRN.withdraw(613, {from: acc4}), 'expired')
        await snapshot.revert(ss)
      }
      await snapshot.revert(ss)
    })

    it("rent fully paid", async() => {
      const ss = await snapshot.take()
      await instRN.setRent(613, {from: acc4})
      expectEvent(await instRN.deposit('61300', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '61300' })  // +100s
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(100) // -100s
        // withdraw the rest of 50s
        await expectRevert(instRN.withdraw(613, {from: acc4}), 'expired')
        await snapshot.revert(ss)
      }
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(80) // -80s
        {
          const receipt = await instRN.withdraw(12260, {from: acc4})
          expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
          expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('12260')
        }
        await expectRevert(instRN.withdraw(613, {from: acc4}), 'expired')
        await snapshot.revert(ss)
      }
      await snapshot.revert(ss)
    })

    it("expired rent exponential decay", async() => {
      const ss = await snapshot.take()
      await instRN.setRent(1000, {from: acc4})
      expectEvent(await instRN.deposit('100000', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '100000' })  // +100s
      await time.increase(100) // -100s

      await testDecayingRent(0, 1000);
        await testDecayingRent(time.duration.hours(1), 998);
        await testDecayingRent(time.duration.hours(24), 929);
        await testDecayingRent(time.duration.hours(84), 750);
        await testDecayingRent(time.duration.hours(126), 625);
      await testDecayingRent(time.duration.weeks(1), 500);
      await testDecayingRent(time.duration.weeks(2), 250);
      await testDecayingRent(time.duration.weeks(3), 125);
      await testDecayingRent(time.duration.weeks(4), 63);
      await testDecayingRent(time.duration.weeks(5), 32);
      await testDecayingRent(time.duration.weeks(6), 16);
        await testDecayingRent(time.duration.hours(1092), 13);
      await testDecayingRent(time.duration.weeks(7), 8);
      await testDecayingRent(time.duration.weeks(8), 4);
      await testDecayingRent(time.duration.weeks(9), 2);
      await testDecayingRent(time.duration.weeks(10), 1);
      await testDecayingRent(time.duration.weeks(11), 1);
      await testDecayingRent(time.duration.weeks(99), 1);

      await snapshot.revert(ss)

      async function testDecayingRent(duration, expectedRent) {
        const fund = new BN(100000)
        const ss = await snapshot.take()
        await time.increase(duration)
        const res = await instRN.deposit.call(fund, {from: acc4})
        expect(res.rent).is.bignumber.at.most(new BN(expectedRent)).at.least(new BN(expectedRent-1))
        expect(res.rent.mul(res.expiration.sub(await time.latest()))).is.bignumber.at.most(fund).gt(fund.sub(res.rent))
        await instRN.deposit(fund, {from: acc4})
        const details = await instRN.getNodeDetails(acc4)
        expect(details.rent).is.bignumber.at.most(new BN(expectedRent)).at.least(new BN(expectedRent-1))
        expect(details.rent.mul(details.expiration.sub(await time.latest()))).is.bignumber.at.most(fund).gt(fund.sub(details.rent))
        await snapshot.revert(ss)
      }
    })
  })

  describe('rent management', () => {
    it("deposit to uninitialized node", async() => {
      await expectRevert(instRN.deposit(1, {from: acc4}), '!rent')
    })

    it("withdraw from uninitialized node", async() => {
      await expectRevert(instRN.withdraw(1, {from: acc4}), '!rent')
    })

    it("set rent to zero", async() => {
      await expectRevert(instRN.setRent(0, {from: acc4}), '!rent')
    })

    it("set rent first time", async() => {
      await setRentAndCheckBalance(13, acc4)
    })

    it("set rent second time with no deposit", async() => {
      await setRentAndCheckBalance(613, acc4)
    })

    it("deposit zero to initialized node", async() => {
      await expectRevert(instRN.deposit(0, {from: acc4}), '!amount')
    })

    it("set rent on expired", async() => {
      await setRentAndCheckBalance(100, acc4)
      expectEvent(await instRN.deposit('100', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '100' })
      await time.increase(100);
      await expectRevert(instRN.setRent(50, {from: acc4}), 'expired')
    })

    it("reactive an expired rent", async() => {
      expectEvent(await instRN.deposit('300000000000', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '300000000000' })
    })

    it("new rent too high", async() => {
      await expectRevert(instRN.setRent(202, {from: acc4}), 'new rent too high')
    })

    it("double the rent", async() => {
      // the first setRent (on uninitialized node) does not trigger the rent cooldown, so this will passed
      await setRentAndCheckBalance(200, acc4)
    })

    it("set rent on cool down", async() => {
      await expectRevert(instRN.setRent(100, {from: acc4}), 'cooldown')
      await time.increase(time.duration.days(6))
      await expectRevert(instRN.setRent(136, {from: acc4}), 'cooldown')
    })

    it("half the rent", async() => {
      await time.increase(time.duration.days(1))
      await setRentAndCheckBalance(100, acc4)
    })

    it("exhaust the balance", async() => {
      await instRN.withdraw('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', {from: acc4})
      await expectRevert(instRN.setRent(10000, {from: acc4}), 'expired')
    })

    it("reactive an exhausted rent", async() => {
      expectEvent(await instRN.deposit('3000', {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '3000' })
    })

    it("set the rent after reactive", async() => {
      await expectRevert(instRN.setRent(136, {from: acc4}), 'cooldown')
    })

    async function setRentAndCheckBalance(newRent, acc4) {
      let details = await instRN.getNodeDetails(acc4)
      if (details.expiration.isZero()) {  // uninitialized node
        return instRN.setRent(newRent, {from: acc4})
      }
      const before = details.rent.mul(details.expiration.sub(await time.latest()))
      await instRN.setRent(newRent, {from: acc4})
      details = await instRN.getNodeDetails(acc4)
      expect(details.rent).is.bignumber.equal(new BN(newRent))
      const after = details.rent.mul(details.expiration.sub(await time.latest()))
      expect(after).is.bignumber.at.most(before).at.least(before.sub(details.rent).sub(details.rent))
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

