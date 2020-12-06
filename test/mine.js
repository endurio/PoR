require('it-each')({ testPerIteration: true });
const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect, util } = require('chai');
const { time, expectRevert, expectEvent, BN } = require('@openzeppelin/test-helpers');
const snapshot = require('./lib/snapshot');
const utils = require('./lib/utils');
const { thousands } = require('../tools/lib/big');

const { keys, txs } = require('./data/por');
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

contract("PoR", accounts => {
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
      expect: {commitRevert: "insufficient work"},
    }, {
      desc: 'x6',
      tx: 'b9abf8270a01d1faa8afe016f4db80e7f3e71a59bcad4238b75a290ebbf37321',
      params: {memoLength: ENDURIO.length},
      expect: {commitRevert: "insufficient work"},
    }, {
      desc: 'x136',
      tx: 'b0804780ba68abd358a0fc66d2a7f29fd1f5b11382cb73806ba8b7e3504460bb',
      params: {memoLength: ENDURIO.length},
      expect: {commitRevert: "insufficient work"},
    }, {
      desc: '(no x)',
      tx: 'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a',
      params: {memoLength: ENDURIO.length},
      expect: {},
    }, {
      desc: 'x2 with no memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: 0},
      expect: {commitRevert: "brand not active"},
    }, {
      desc: 'x2 with smaller memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length-1},
      expect: {commitRevert: "brand not active"},
    }, {
      desc: 'x2 with larger memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length+1},
      expect: {commitRevert: "brand not active"},
    }, {
      desc: 'x2 with way larger memoLength',
      tx: '302578f795daa5aa45751bdcdcd0a3213824c2bd70aeeade5807e414e5c6166f',
      params: {memoLength: ENDURIO.length+60},
      expect: {commitRevert: "OOB: memo length"},
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

    async function testXMine(txHash, {memoLength, multiplier}, {commitRevert, claimRevert}) {
      const {params, outpoint, bounty} = utils.prepareCommit({txHash, brand: ENDURIO});

      if (memoLength != null) {
        params.memoLength = memoLength;
      }

      const promise = utils.commit(params, outpoint, bounty)

      if (commitRevert) {
        return expectRevert(promise, commitRevert);
      }

      const commitReceipt = await promise;

      await utils.timeToClaim(txHash)
      const txData = txs[txHash]

      if (claimRevert) {
        return expectRevert(utils.claim(commitReceipt), claimRevert);
      }

      { // snapshot scope
        const ss = await snapshot.take();
        await utils.registerPK(txData.miner, DUMMY_ADDRESS)
        await expectEventClaim(utils.claim(commitReceipt), txHash, DUMMY_ADDRESS, multiplier);
        await snapshot.revert(ss);
      }

      await utils.registerPK(txData.miner)
      return expectEventClaim(utils.claim(commitReceipt), txHash, txData.miner, multiplier);
    }
  })

  it("miner", async() => {
    const ss = await snapshot.take();
    await instPoR.registerPubKey('0x'+sender.public, keys[1].address); // register and set the recipient
    await expectRevert(
          instPoR.registerPubKey('0x'+sender.public, ZERO_ADDRESS), "registered");

    await expectRevert(
          instPoR.registerPubKey('0x'+keys[1].public, sender.address), "!owner");

    // register the rest
    for (let i = 2; i < keys.length; ++i) {
      await instPoR.registerPubKey('0x'+keys[i].public, ZERO_ADDRESS, {from: keys[i].address});
    }
    await snapshot.revert(ss);
  })

  describe('mining', () => {
    it("commit competition", async() => {
      const losingTx = 'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a'
      const winingTx = 'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78' // intentional typo

      const ss = await snapshot.take();
      await utils.commitTx(losingTx)
      await utils.commitTx(winingTx)
      await expectRevert(utils.commitTx(losingTx), 'lost');
      await snapshot.revert(ss);
    })

    it("commit custom PK position in redeem script", async() => {
      const commitTxs = [
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
      ]
      for (const txHash of commitTxs) {
        const txData = txs[txHash]
        const {params, outpoint, bounty} = utils.prepareCommit({txHash, brand: ENDURIO});

        await utils.registerPK(txData.miner)

        await testPosPK(-1, undefined, "unregistered PKH");
        await testPosPK(4, undefined, "unregistered PKH");
        await testPosPK(5, "Slice out of bounds", undefined);
        await testPosPK(0);

        async function testPosPK(pubkeyPosOffset, commitRevert, claimRevert) {
          const p = {
            ...params,
            pubkeyPos: params.pubkeyPos+pubkeyPosOffset,
          }
          if (commitRevert) {
            return expectRevert(utils.commit(p, outpoint, bounty), commitRevert);
          }
          const ss = await snapshot.take();
          const commitReceipt = await utils.commit(p, outpoint, bounty);
          await utils.timeToClaim(txHash)
          if (claimRevert) {
            await expectRevert(utils.claim(commitReceipt), claimRevert);
          } else {
            await utils.claim(commitReceipt);
          }
          await snapshot.revert(ss);
        }
      }
    })

    it("custom pkhPos", async() => {
      const commitTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
      ]
      const wrongDxHash = 'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c';

      for (const txHash of commitTxs) {
        const txData = txs[txHash]
        const {params, outpoint, bounty} = utils.prepareCommit({txHash, brand: ENDURIO});

        await utils.registerPK(txData.miner)

        await mineTest({params, outpoint, bounty}, {})
        await mineTest({params, outpoint: [{...outpoint[0], pkhPos: 10}], bounty}, {claimRevert: 'unregistered PKH'})

        // PKH position in output script is different between segwit and legacy
        const isSegWit = txData.hex.slice(8, 10) === '00';
        await mineTest({params, outpoint: [{...outpoint[0], pkhPos: isSegWit?11:12}], bounty}, {})

        await mineTest(utils.prepareCommit({txHash, brand: ENDURIO}, {dxHash: wrongDxHash}), {commitRevert: 'outpoint mismatch'})

        async function mineTest({params, outpoint, bounty}, {commitRevert, claimRevert}) {
          if (commitRevert) {
            return expectRevert(utils.commit(params, outpoint, bounty), commitRevert);
          }
          const ss = await snapshot.take();
          const commitReceipt = await utils.commit(params, outpoint, bounty);
          await utils.timeToClaim(txHash)
          if (claimRevert) {
            await expectRevert(utils.claim(commitReceipt), claimRevert);
          } else {
            await utils.claim(commitReceipt);
          }
          await snapshot.revert(ss);
        }
      }
    })

    it("commit with no OP_RET", async() => {
      const commitTxs = [
        'e8c8a653e4bdcad2556c5dc93e1261e89b6eb69c5349a3f49360db68208699d2',
      ]
      for (const txHash of commitTxs) {
        const {params, outpoint, bounty} = utils.prepareCommit({txHash, brand: ENDURIO});
        await expectRevert(utils.commit(params, outpoint, bounty), '!OP_RET');
      }
    })
  })

  describe('sticky', () => {
    const commitReceipts = {}

    it("commit txs", async() => {
      const commitTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
        'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a',
        'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
        '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
        '9da4809c20689edf1874a47f8b9c60adbcd888400eb46b368cd21cdbe2517e5d',
        '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
      ]

      for (const txHash of commitTxs) {
        const txData = txs[txHash]
        const block = bitcoinjs.Block.fromHex(blocks[txData.block].substring(0, 160));
        const {params, outpoint, bounty} = utils.prepareCommit({txHash, brand: ENDURIO});

        await expectRevert(utils.commit({...params, merkleIndex: params.merkleIndex+1}, outpoint, bounty), 'invalid merkle proof');

        await expectRevert(utils.commit({...params, merkleProof: '0x'+params.merkleProof.slice(66)}, outpoint, bounty), 'invalid merkle proof');

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60-30) // give the chain 30s tolerance
          await utils.commit(params, outpoint, bounty);
          await snapshot.revert(ss);
        }

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60)
          await expectRevert(
            utils.commit(params, outpoint, bounty),
            'mining time over',
          );
          await snapshot.revert(ss);
        }

        const tx = bitcoinjs.Transaction.fromHex(txData.hex)
        const promise = utils.commit({...params, inputIndex: 1}, outpoint, bounty)
        if (tx.ins.length == 1) {
          await expectRevert(promise, 'Vin read overrun')
        } else {
          if (outpoint.length == 1 && !tx.ins[0].hash.equals(tx.ins[1].hash)) {
            await expectRevert(promise, 'outpoint mismatch')
          } else {
            await promise
          }
        }

        // commit with bad header
        await expectRevert(utils.commit({
          ...params,
          header: params.header.substring(0,params.header.length-8) + '00000000',  // clear the 4-bytes nonce
        }, outpoint, bounty), 'insufficient work')

        // correct data
        commitReceipts[txHash] = await utils.commit(params, outpoint, bounty);
      }
    })

    it("claim", async() => {
      const commitTxs = [
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

      for (const txHash of commitTxs) {
        const commitReceipt = commitReceipts[txHash]
        expect(commitReceipt, 'should the transaction have a commit receipt').to.be.not.null

        const txData = txs[txHash];
        const block = bitcoinjs.Block.fromHex(blocks[txData.block]);

        const targetTimestamp = block.timestamp + 60*60;
        if (await time.latest() < targetTimestamp) {
          await expectRevert(utils.claim(commitReceipt), "too soon");
          ++tooSoonTestsCount
          await utils.timeToClaim(txHash);
        }

        await utils.registerPK(txData.miner)

        // expect revert on claiming with fake reward
        const mined = commitReceipt.logs.find(log => log.event === 'Mined').args
        await expectRevert(instPoR.claim(mined.blockHash, mined.memoHash, mined.payer, mined.pkh, mined.amount+1, mined.timestamp), "commitment mismatch");
        await expectRevert(instPoR.claim(mined.blockHash, mined.memoHash, mined.payer, mined.pkh, mined.amount, mined.timestamp-60*60), "commitment mismatch");
        await expectRevert(instPoR.claim(mined.blockHash, mined.memoHash, mined.payer, DUMMY_ADDRESS, mined.amount, mined.timestamp), "commitment mismatch");
        await expectRevert(instPoR.claim(mined.blockHash, mined.memoHash, DUMMY_ADDRESS, mined.pkh, mined.amount, mined.timestamp), "commitment mismatch");

        // honest claim
        await expectEventClaim(utils.claim(commitReceipt), txHash, txData.miner);

        // double claim
        await expectRevert(utils.claim(commitReceipt), "commitment mismatch");
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
  expectEvent(receipt, 'Rewarded', {
    memoHash: ENDURIO_HASH,
    payer: ZERO_ADDRESS,
    miner,
    value: reward.base.toString(),
  });
}