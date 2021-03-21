require('it-each')({ testPerIteration: true });
const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect, util } = require('chai');
const { time, expectRevert, expectEvent, BN } = require('@openzeppelin/test-helpers');
const snapshot = require('./lib/snapshot');
const utils = require('./lib/utils');
const { thousands } = require('../tools/lib/big');

const { keys, txs } = require('./data/all');
const blocks = utils.loadBlockData()

const Endurio = artifacts.require("Endurio");
const PoR = artifacts.require("PoR");
const RefNetwork = artifacts.require("RefNetwork");
let inst;
let instPoR;
let instRN;

const ENDURIO = Buffer.from('endur.io');
const ENDURIO_HASH = '0x022086784c27d04e67d08b0afbf4f0459c59a00094bd15dab852f4fa981d2147';  // KECCAK('endur.io')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DUMMY_ADDRESS = '0x0123456789012345678901234567890123456789';
const DUMMY_HASH = '0x0123456789012345678901234567890123456789012345678901234567890123';

contract("PoR", accounts => {
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
  });

  before('should utils is properly initialized', async () => {
    await utils.initialize()
    expect(utils.inst, 'utils contract instances not initialized').to.not.be.null
  })

  describe('x-mining', () => {
    const tests = [{
      desc: 'x3',
      tx: '3ef4453b2cfff417c4c37e3fa2ec0922162262d49ffe5d43f8c010709cfb4b11',
      params: {memoLength: ENDURIO.length},
      expect: {submitRevert: "insufficient work"},
    }, {
      desc: 'x3',
      tx: 'd9234565991092880eebf40d941dec83afe7dc859cfb8e1d49029b2254e405e1',
      params: {memoLength: ENDURIO.length},
      expect: {submitRevert: "insufficient work"},
    }, {
      desc: 'x6',
      tx: 'b9abf8270a01d1faa8afe016f4db80e7f3e71a59bcad4238b75a290ebbf37321',
      params: {memoLength: ENDURIO.length},
      expect: {submitRevert: "insufficient work"},
    }, {
      desc: 'x136',
      tx: 'b0804780ba68abd358a0fc66d2a7f29fd1f5b11382cb73806ba8b7e3504460bb',
      params: {memoLength: ENDURIO.length},
      expect: {submitRevert: "insufficient work"},
    }, {
      desc: '(no x)',
      tx: 'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a',
      params: {memoLength: ENDURIO.length},
      expect: {},
    }, {
      desc: 'x2 with no memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: 0},
      expect: {submitRevert: "brand not active"},
    }, {
      desc: 'x2 with smaller memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length-1},
      expect: {submitRevert: "brand not active"},
    }, {
      desc: 'x2 with larger memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length+1},
      expect: {submitRevert: "brand not active"},
    }, {
      desc: 'x2 with way larger memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length+60},
      expect: {submitRevert: "OOB: memo length"},
    }, {
      desc: 'x2 with correct memoLength and multiplier = 2',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length, multiplier: 2},
      expect: {},
    }]

    it.each(tests, "%s", ['desc'], async (test, next) => {
      const ss = await snapshot.take();
      await testXMine(test.tx, test.params, test.expect);
      next();
      await snapshot.revert(ss);
    })

    async function testXMine(txHash, {memoLength, multiplier}, {submitRevert, claimRevert}) {
      const {params, outpoint, bounty} = utils.prepareSubmit({txHash, brand: ENDURIO});

      if (memoLength != null) {
        params.memoLength = memoLength;
      }

      const promise = utils.submit(params, outpoint, bounty)

      if (submitRevert) {
        return expectRevert(promise, submitRevert);
      }

      const submitReceipt = await promise;

      await utils.timeToClaim(txHash)
      const txData = txs[txHash]

      if (claimRevert) {
        return expectRevert(utils.claim(submitReceipt), claimRevert);
      }

      return expectEventClaim(utils.claim(submitReceipt), txHash, txData.miner, multiplier);
    }
  })

  describe('mining', () => {
    it("submit competition", async() => {
      const losingTx = 'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a'
      const winingTx = 'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78' // intentional typo

      const ss = await snapshot.take();
      await utils.submitTx(losingTx)
      await utils.submitTx(winingTx)
      await expectRevert(utils.submitTx(losingTx), 'taken');
      await snapshot.revert(ss);
    })

    it("submit custom PK position in redeem script", async() => {
      const testingTxs = [
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
      ]
      for (const txHash of testingTxs) {
        const txData = txs[txHash]
        const {params, outpoint, bounty} = utils.prepareSubmit({txHash, brand: ENDURIO});

        await testPosPK(-1, {missingMiner: true});
        await testPosPK(4, {missingMiner: true});
        await testPosPK(5, {submitRevert: "Slice out of bounds"});
        await testPosPK(0);

        async function testPosPK(pubkeyPosOffset, {submitRevert, missingMiner}={}) {
          const p = {
            ...params,
            pubkeyPos: params.pubkeyPos+pubkeyPosOffset,
          }
          if (submitRevert) {
            return expectRevert(utils.submit(p, outpoint, bounty), submitRevert);
          }
          const ss = await snapshot.take();
          const submitReceipt = await utils.submit(p, outpoint, bounty);
          await utils.timeToClaim(txHash)
          if (missingMiner) {
            try {
              await utils.claim(submitReceipt);
            } catch(err) {
              expect(err).contains('missing miner')
            }
          } else {
            await utils.claim(submitReceipt);
          }
          await snapshot.revert(ss);
        }
      }
    })

    it("custom pkhPos", async() => {
      const testingTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
      ]
      const wrongDxHash = 'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c';

      for (const txHash of testingTxs) {
        const txData = txs[txHash]
        const {params, outpoint, bounty} = utils.prepareSubmit({txHash, brand: ENDURIO});

        await mineTest({params, outpoint, bounty}, {})
        await mineTest({params, outpoint: [{...outpoint[0], pkhPos: 10}], bounty}, {missingMiner: true})

        // PKH position in output script is different between segwit and legacy
        const isSegWit = txData.hex.slice(8, 10) === '00';
        await mineTest({params, outpoint: [{...outpoint[0], pkhPos: isSegWit?11:12}], bounty}, {})

        await mineTest(utils.prepareSubmit({txHash, brand: ENDURIO}, {dxHash: wrongDxHash}), {submitRevert: 'outpoint mismatch'})

        async function mineTest({params, outpoint, bounty}, {submitRevert, claimRevert, missingMiner}) {
          if (submitRevert) {
            return expectRevert(utils.submit(params, outpoint, bounty), submitRevert);
          }
          const ss = await snapshot.take();
          const submitReceipt = await utils.submit(params, outpoint, bounty);
          await utils.timeToClaim(txHash)
          if (claimRevert) {
            await expectRevert(utils.claim(submitReceipt), claimRevert);
          } else if (missingMiner) {
            try {
              await utils.claim(submitReceipt);
            } catch(err) {
              expect(err).contains('missing miner')
            }
          } else {
            await utils.claim(submitReceipt);
          }
          await snapshot.revert(ss);
        }
      }
    })

    it("submit with no OP_RET", async() => {
      const testingTxs = [
        'e8c8a653e4bdcad2556c5dc93e1261e89b6eb69c5349a3f49360db68208699d2',
      ]
      for (const txHash of testingTxs) {
        const {params, outpoint, bounty} = utils.prepareSubmit({txHash, brand: ENDURIO});
        await expectRevert(utils.submit(params, outpoint, bounty), '!OP_RET');
      }
    })
  })

  describe('sticky', () => {
    const submitReceipts = {}

    it("submit txs", async() => {
      const testingTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
        'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a',
        'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
        '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
        '9da4809c20689edf1874a47f8b9c60adbcd888400eb46b368cd21cdbe2517e5d',
        '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
      ]

      for (const txHash of testingTxs) {
        const txData = txs[txHash]
        const block = bitcoinjs.Block.fromHex(blocks[txData.block].substring(0, 160));
        const {params, outpoint, bounty} = utils.prepareSubmit({txHash, brand: ENDURIO});

        await expectRevert(utils.submit({...params, merkleIndex: params.merkleIndex+1}, outpoint, bounty), 'invalid merkle proof');

        await expectRevert(utils.submit({...params, merkleProof: '0x'+params.merkleProof.slice(66)}, outpoint, bounty), 'invalid merkle proof');

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60-30) // give the chain 30s tolerance
          await utils.submit(params, outpoint, bounty);
          await snapshot.revert(ss);
        }

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60)
          await expectRevert(
            utils.submit(params, outpoint, bounty),
            'submitting time over',
          );
          await snapshot.revert(ss);
        }

        const tx = bitcoinjs.Transaction.fromHex(txData.hex)

        const ss = await snapshot.take()
        const promise = utils.submit({...params, inputIndex: 1}, outpoint, bounty)
        if (tx.ins.length == 1) {
          await expectRevert(promise, 'Vin read overrun')
        } else {
          if (outpoint.length == 1 && !tx.ins[0].hash.equals(tx.ins[1].hash)) {
            await expectRevert(promise, 'outpoint mismatch')
          } else {
            await promise
          }
        }
        await snapshot.revert(ss)

        // submit with bad header
        await expectRevert(utils.submit({
          ...params,
          header: params.header.substring(0,params.header.length-8) + '00000000',  // clear the 4-bytes nonce
        }, outpoint, bounty), 'insufficient work')

        // correct data
        submitReceipts[txHash] = await utils.submit(params, outpoint, bounty);
      }
    })

    it("claim", async() => {
      const testingTxs = [
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
      //'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a', // missing miner key?
        'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
        '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
        '9da4809c20689edf1874a47f8b9c60adbcd888400eb46b368cd21cdbe2517e5d',
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
      ]
      const ownMinerTests = {}
      let tooSoonTestsCount = 0

      for (const txHash of testingTxs) {
        const submitReceipt = submitReceipts[txHash]
        expect(submitReceipt, 'should the transaction have a submit receipt').to.be.not.null

        const txData = txs[txHash];
        const block = bitcoinjs.Block.fromHex(blocks[txData.block]);

        const targetTimestamp = block.timestamp + 60*60;
        if (await time.latest() < targetTimestamp) {
          await expectRevert(utils.claim(submitReceipt), "too soon");
          ++tooSoonTestsCount
          await utils.timeToClaim(txHash);
        }

        // expect revert on claiming with fake reward
        const mined = submitReceipt.logs.find(log => log.event === 'Submit').args
        const key = utils.minerToClaim(mined)
        const params = utils.paramsToClaim(mined)
        await expectRevert(instPoR.claim({...params, payer: DUMMY_ADDRESS}, {from: key.address}), "#commitment");
        await expectRevert(instPoR.claim({...params, amount: params.amount+1}, {from: key.address}), "#commitment");
        await expectRevert(instPoR.claim({...params, timestamp: params.timestamp-1}, {from: key.address}), "#commitment");
        await expectRevert(instPoR.claim({...params, isPKH: !params.isPKH}, {from: key.address}), "#commitment");
        await expectRevert(instPoR.claim({...params, pubX: DUMMY_HASH}, {from: key.address}), "#commitment");
        await expectRevert(instPoR.claim({...params, pubY: '0x'+(BigInt(params.pubY)-2n).toString(16)}, {from: key.address}), "!miner");

        // honest claim
        await expectEventClaim(utils.claim(submitReceipt), txHash, txData.miner);

        // double claim
        await expectRevert(utils.claim(submitReceipt), "claimed");
      }

      expect(tooSoonTestsCount).to.be.gt(0, "should test data cover `too soon` case");
    })

  })
})

async function expectEventClaim(call, txHash, miner, multiplier) {
  const reward = utils.getExpectedReward(txHash, multiplier);

  console.log(`          + ${thousands(reward.base)}` + (
    !reward.nBounty ? '' : ` * 2x${reward.nBounty}` +
      (!reward.retarget ? '' : ` / ${thousands(reward.retarget)}`) +
      ` = ${thousands(reward.bounty)}`)
  )

  const commission = reward.base / BigInt(2);

  const receipt = await call;
  expect(receipt.logs.length).to.equal(3, "claim must emit 3 events");
  expectEvent(receipt, 'CommissionLost', {
    payer: ZERO_ADDRESS,
    miner,
    value: commission.toString(),
  });
  expectEvent(receipt, 'Transfer', {
    from: ZERO_ADDRESS,
    to: miner,
    value: reward.base.toString(),
  });
  expectEvent(receipt, 'Claim', {
    memoHash: ENDURIO_HASH,
    payer: ZERO_ADDRESS,
    miner,
    value: reward.base.toString(),
  });
}
