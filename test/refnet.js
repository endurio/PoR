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

const WEEK = 604800;
const UPGRADE = WEEK/2;
const ESCALATE = UPGRADE*3;

contract("RefNetwork", accounts => {
  const acc1 = accounts[accounts.length-1]
  const acc2 = accounts[accounts.length-2]
  const acc3 = accounts[accounts.length-3]
  const acc4 = accounts[accounts.length-4]

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
    it("setRent and deposit", async() => {
      const ss = await snapshot.take()
      await expectRevert(instRN.update(1, 0, false, {from: acc4}), '!rent')
      await expectRevert(instRN.update(100, 13, false, {from: acc4}), '!escalate')
      await expectRevert(instRN.update(100, 13, true, {from: acc4}), 'balance < upgrade fee')
      await expectRevert(instRN.update(10, -1, true, {from: acc4}), 'newRent overflow ui192')
      expectEvent(await instRN.update(ESCALATE*13+100, 13, true, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: (ESCALATE*13+100).toString() })

      await instRN.update(45, 9, false, {from: acc4})
      const details = await instRN.query(acc4)
      expect(details.rent).is.bignumber.equal(new BN(9))
      const after = details.rent.mul(details.expiration.sub(await time.latest()))
      expect(after).is.bignumber.at.most('135').at.least('117')

      await snapshot.revert(ss)
    })

    it("over deposit with rent = 1", async() => {
      const ss = await snapshot.take()
      if (true) {
        await expectRevert(instRN.update(400+'0'.repeat(8)+'1', 1, false, {from: acc4}), 'exceeds balance')
      } else {  // remove the _burn line in RefNetwork.deposit to test this block
        await expectRevert(instRN.update('115792089237316195423570985008687907853269984665640564039457584007913129639935', 1, false, {from: acc4}), 'addition overflow')
        await expectRevert(instRN.update('18446744073709551615', 1, false, {from: acc4}), 'expiration overflow ui64')
        await instRN.update(0, 2, false, {from: acc4})
        await instRN.update('18446744073709551615', 0, false, {from: acc4})
      }
      await snapshot.revert(ss)
    })

    it("exact deposit and withdraw with rent = 1", async() => {
      const ss = await snapshot.take()
      expectEvent(await instRN.update(ESCALATE+613, 1, true, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: (ESCALATE+613).toString() })
      expectEvent(await instRN.update(13, 0, false, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '13' })
      await expectRevert(instRN.update(-0, 0, false, {from: acc4}), 'noop')
      expectEvent(await instRN.update(-136, 0, false, {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '136' })
      {
        const receipt = await instRN.update(-490, 0, false, {from: acc4})
        expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
        expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('490')
      }
      await expectRevert(instRN.update(-1, 0, false, {from: acc4}), '!balance')
      await snapshot.revert(ss)
    })

    it("truncated deposit with rent > 1", async() => {
      const ss = await snapshot.take()
      expectEvent(await instRN.update(ESCALATE*13+130, 13, true, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: (ESCALATE*13+130).toString() })
      expectEvent(await instRN.update(136, 0, false, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: '136' }) // +130
      await expectRevert(instRN.update(-0, 0, false, {from: acc4}), 'noop')
      expectEvent(await instRN.update(-12, 0, false, {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '12' })  // -13
      expectEvent(await instRN.update(-14, 0, false, {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '14' })  // -26
      expectEvent(await instRN.update(-40, 0, false, {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '40' })  // -52
      {
        const receipt = await instRN.update('0x8000000000000000000000000000000000000000000000000000000000000000', 0, false, {from: acc4})
        expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
        expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('169') // 130+130-13-26-52
      }
      await expectRevert(instRN.update(-1, 0, false, {from: acc4}), '!balance')
      await snapshot.revert(ss)
    })

    it("rent half paid", async() => {
      const ss = await snapshot.take()
      expectEvent(await instRN.update(ESCALATE*613+61300, 613, true, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: (ESCALATE*613+61300).toString() })  // +100s
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(50) // -50s
        // withdraw the rest of 50s
        {
          const receipt = await instRN.update(-30650-613, 0, false, {from: acc4})
          expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
          expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('30650')
        }
        await expectRevert(instRN.update(-1, 0, false, {from: acc4}), '!balance')
        await snapshot.revert(ss)
      }
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(50) // -50s
        expectEvent(await instRN.update(-18390, 0, false, {from: acc4}), 'Transfer', { from: ZERO_ADDRESS, to: acc4, value: '18390' })
        {
          const receipt = await instRN.update(-12260, 0, false, {from: acc4})
          expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
          expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('12260')
        }
        await expectRevert(instRN.update(-1, 0, false, {from: acc4}), '!balance')
        await snapshot.revert(ss)
      }
      await snapshot.revert(ss)
    })

    it("rent fully paid", async() => {
      const ss = await snapshot.take()
      expectEvent(await instRN.update(ESCALATE*613+61300, 613, true, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: (ESCALATE*613+61300).toString() })  // +100s
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(100) // -100s
        // withdraw the rest of 50s
        await expectRevert(instRN.update(-613, 0, false, {from: acc4}), '!balance')
        await snapshot.revert(ss)
      }
      { // snapshot scope
        const ss = await snapshot.take()
        await time.increase(80) // -80s
        {
          const receipt = await instRN.update(-12260, 0, false, {from: acc4})
          expectEvent(receipt, 'Transfer', { from: ZERO_ADDRESS, to: acc4 })
          expect(receipt.logs.find(log => log.event === 'Transfer').args.value).is.bignumber.at.most('12260')
        }
        await expectRevert(instRN.update(-613, 0, false, {from: acc4}), '!balance')
        await snapshot.revert(ss)
      }
      await snapshot.revert(ss)
    })

    it("expired rent exponential decay", async() => {
      const ss = await snapshot.take()
      expectEvent(await instRN.update(ESCALATE*1000+100000, 1000, true, {from: acc4}), 'Transfer', { from: acc4, to: ZERO_ADDRESS, value: (ESCALATE*1000+100000).toString() })  // +100s
      await time.increase(100) // -100s

      await testDecayingRent(0, 1000);
        await testDecayingRent(time.duration.hours(1), 998);
        await testDecayingRent(time.duration.hours(24), 929);
        await testDecayingRent(time.duration.hours(84), 750);
        await testDecayingRent(time.duration.hours(126), 625);
      await testDecayingRent(time.duration.weeks(1), 500);
      await testDecayingRent(time.duration.weeks(2), 250);
      await testDecayingRent(time.duration.weeks(3), 125);
      await testDecayingRent(time.duration.weeks(4), 62);
      await testDecayingRent(time.duration.weeks(5), 31);
      await testDecayingRent(time.duration.weeks(6), 15);
        await testDecayingRent(time.duration.hours(1092), 12);
      await testDecayingRent(time.duration.weeks(7), 7);
      await testDecayingRent(time.duration.weeks(8), 3);
      await testDecayingRent(time.duration.weeks(9), 1);
      await testDecayingRent(time.duration.weeks(10), 0);
      await testDecayingRent(time.duration.weeks(11), 0);
      await testDecayingRent(time.duration.weeks(99), 0);

      await snapshot.revert(ss)

      async function testDecayingRent(duration, expectedRent) {
        const fund = new BN(100000)
        const ss = await snapshot.take()
        await time.increase(duration)
        let details = await instRN.query(acc4)
        if (details.decayingRent.isZero()) {
          // completely decayed
          await expectRevert(instRN.update(fund, 1, false, {from: acc4}), '!escalate')
          await expectRevert(instRN.update(fund, 1, true, {from: acc4}), 'balance < upgrade fee')
        } else {
          const res = await instRN.update.call(fund, expectedRent, false, {from: acc4})
          expect(res.rent).is.bignumber.equal(new BN(expectedRent))
          expect(res.rent.mul(res.expiration.sub(await time.latest()))).is.bignumber.at.most(fund).gt(fund.sub(res.rent))
          await instRN.update(fund, expectedRent, false, {from: acc4})
          details = await instRN.query(acc4)
          expect(details.rent).is.bignumber.equal(new BN(expectedRent))
          expect(details.rent.mul(details.expiration.sub(await time.latest()))).is.bignumber.at.most(fund).gt(fund.sub(details.rent))
        }
        await snapshot.revert(ss)
      }
    })
  })

  describe('rent management', () => {
    it("deposit to uninitialized node", async() => {
      await expectRevert(instRN.update(1, 0, false, {from: acc4}), '!rent')
    })

    it("withdraw from uninitialized node", async() => {
      await expectRevert(instRN.update(-1, 0, false, {from: acc4}), '!balance')
    })

    it("set rent to zero", async() => {
      await expectRevert(instRN.update(0, 0, false, {from: acc4}), 'noop')
    })

    it("init a node", async() => {
      await updateAndVerify({
        fund: 300000000000,
        newRent: 1300,
        escalate: true,
      }, {fee: ESCALATE*1300})
    })

    it("escalate with no deposit", async() => {
      await updateAndVerify({
        newRent: 61300,
        escalate: true,
      }, {fee: ESCALATE*(61300-1300)})
    })

    it("downgrade with deposit", async() => {
      await updateAndVerify({
        fund: 1000000000,
        newRent: 13600,
      }, {fee: 0})
    })

    it("withdraw", async() => {
      await updateAndVerify({
        fund: -123456000,
      }, {fee: 0})
    })

    it("deposit", async() => {
      await updateAndVerify({
        fund: 123000,
      }, {fee: 0})
    })

    it("escalate and withdraw", async() => {
      await updateAndVerify({
        fund: -166880000000,
        newRent: 100000,
        escalate: true,
      }, {fee: ESCALATE*(100000-13600)})
    })

    it("withdraw on expired", async() => {
      await time.increase(100);
      await expectRevert(instRN.update(-1, 0, false, {from: acc4}), '!balance')
    })

    it("reactive an expired rent", async() => {
      await time.increase(4000000);
      const before = await instRN.query(acc4)
      await updateAndVerify({
        fund: 100000000000,
        newRent: 3000,
        escalate: true,
      }, {fee: ESCALATE*(3000-before.decayingRent.toNumber())})
    })

    it("normal upgrade: double the rent", async() => {
      await time.increase(WEEK);
      await updateAndVerify({
        newRent: 6000,
      }, {fee: UPGRADE*3000})
    })

    it("normal upgrade: +1 wei", async() => {
      await time.increase(WEEK);
      await updateAndVerify({
        newRent: 6001,
      }, {fee: UPGRADE})
    })

    it("normal upgrade: too soon", async() => {
      await expectRevert(instRN.update(0, 6002, false, {from: acc4}), "!escalate")
    })

    it("normal upgrade: too high", async() => {
      await time.increase(WEEK);
      await expectRevert(instRN.update(0, 12003, false, {from: acc4}), "!escalate")
    })

    it("half the rent", async() => {
      await updateAndVerify({
        newRent: 6000,
      }, {fee: 0})
    })

    async function updateAndVerify({fund = 0, newRent = 0, escalate = false, acc: from = acc4}, {fee}) {
      const before = await instRN.query(from)
      const res = await instRN.update.call(fund, newRent, !!escalate, {from})
      if (_.isUndefined(fee)) {
        fee = res.fee
      } else {
        fee = new BN(fee)
        expect(res.fee).is.bignumber.equal(fee, 'is the fee correct')
      }
      await instRN.update(fund, newRent, !!escalate, {from})
      const after = await instRN.query(from)
      const expectedBalance = before.balance.add(new BN(fund)).sub(fee)
      const expectedBalanceMin = expectedBalance.sub(after.rent).sub(BN.max(before.rent, after.rent))
      console.log(`          + ${after.balance.toString()} in [${expectedBalance},${expectedBalanceMin})`)
      expect(after.balance, 'is the result balance correct').is.bignumber.at.most(expectedBalance).gt(expectedBalanceMin)
    }

  })

  async function mineSomeCoin() {
    const txHash = 'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c'
    await mine(txHash)
    return txs[txHash].miner
  }

  async function mine(txHash, payer) {
    const submitReceipt = await utils.submitTx(txHash, payer)
    await utils.timeToClaim(txHash)
    return await utils.claim(submitReceipt)
  }
})

