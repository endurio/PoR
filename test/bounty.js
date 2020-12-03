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

const { keys, txs } = require('./data/por');
const blocks = utils.loadBlockData()

const ENDR = artifacts.require("ENDR");
const PoR = artifacts.require("PoR");
const RefNetwork = artifacts.require("RefNetwork");
const BrandMarket = artifacts.require("BrandMarket");
let inst;
let instPoR;
let instRN;
let instBM;

const ENDURIO = Buffer.from('endur.io');
const ENDURIO_HASH = web3.utils.keccak256(ENDURIO);
const FOOBAR = Buffer.from('foobar');
const FOOBAR_HASH = web3.utils.keccak256(FOOBAR);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const RecipientRate = 32;

contract("PoR: Bounty Mining", accounts => {
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

  describe('bounty hunter', () => {
    it("mine some coin", async() => {
      const miner = await mineSomeCoin()
      expect(utils.addressCompare(miner.address, sender.address)).to.equal(0, "should the miner address is the truffle test account")
      const balance = await inst.balanceOf(sender.address)
      expect(balance).to.be.bignumber.equal(new BN(274882101312), "should some coin be mined")
    })

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

    it("bounty mining", async() => {
      const payer = sender.address;

      const commitTxs = {
        'e79262b32f1514104ba1895ab881c62f11e355bd449d0918180dc86e2b184d09': 'bounty: unacceptable recipient',
        '73d229d9ca76efaf53d9fd1f361f054155d15b7d38244c9eaa2e292f6bc243f2': 'bounty: unacceptable recipient',
        'bc9168e6cedd9cc8d422892482ac4bd7e99cd2f90b97ef4f7695480e166d3b17': undefined,
        'b32e72a5eb6c60d6b640e01749b459df83838b987e16fe594c0bdaba7668f7dd': 'bounty: dust output',
        '8fc78e141b1e3ce488d4d06f387f4fb8a78f87b9b3949d7bfe2fb70d9a984444': undefined,
        '2c0c3efedd5491d96b07928d8d9e4a2a7be4aa2645e13e7bcc2325fc67675b45': 'bounty: too many recipients',
        '6a2652dbf94de4fd2bdfea0e3faf600683cfed30240e6acf0f281600e665ca3f': 'bounty: duplicate recipient',
        'f648fc11f34150ce9841f1ad7cd22a7cf6ee394f1787d055d5a90c509d5213cc': 'bounty: duplicate recipient',
        'a53fe9e6a9d7dcc4cda86af4d12e6632dd6f762abc084d21ba3b850e2a918ea2': 'bounty: sampling recipient has OP_RET',
        '4ba472143eee31c4b0557682ee6f025c52fcaea8c5eac735be237021fd9f2724': 'bounty: dust output',
        'e4957541a90d54d0b8d8e8262fbc4f33df8f490e524f9a240b34538346032410': 'bounty: block too old',
      }

      for (const txHash of Object.keys(commitTxs)) {
        const reason = commitTxs[txHash]
        console.log('          + ' + (reason || 'success'))

        const nBounty = utils.countBounty(txHash)
        const brand = utils.guessMemo(txHash)
        const memoHash = web3.utils.keccak256(Buffer.from(brand))
        const txData = txs[txHash]
        const rewardWithBounty = utils.getExpectedReward(txData.block, payRate, nBounty)
        const reward = utils.getExpectedReward(txData.block, payRate)

        const miner = keys.find(k => k.address == txData.miner)
        const recipient = miner.address
        await instPoR.registerMiner('0x'+miner.public, ZERO_ADDRESS) // register and set the recipient

        expect(reward.toString()).equal((rewardWithBounty/BigInt(2*nBounty)).toString(), 'reward with bounty rate')

        const {params, outpoint, bounty} = utils.prepareCommit({txHash, brand, payer});

        { // snapshot scope
          const ss = await snapshot.take();
          // commit without bounty
          const commitReceipt = await utils.commit(params, outpoint, [])
          await utils.timeToClaim(txHash)
          expectEventClaim(await utils.claim(commitReceipt), recipient, reward, payer, memoHash)
          await snapshot.revert(ss);
        }

        if (reason) {
          await expectRevert(utils.commit(params, outpoint, bounty), reason)
          continue
        }

        // commit with bad bounty block header
        await expectRevert(utils.commit(params, outpoint, [{
          ...bounty[0],
          header: bounty[0].header.substring(0,bounty[0].header.length-8) + '00000000',  // clear the 4-bytes nonce
        }]), 'bounty: insufficient work')

        // commit with bad merkle index
        await expectRevert(utils.commit(params, outpoint, [{
          ...bounty[0],
          merkleIndex: bounty[0].merkleIndex+1,
        }]), 'bounty: invalid merkle proof')

        // commit with bad merkle proof
        await expectRevert(utils.commit(params, outpoint, [{
          ...bounty[0],
          merkleProof: bounty[0].merkleProof.substring(0, bounty[0].merkleProof.length-2) + '00', // clear the last byte of the proof
        }]), 'bounty: invalid merkle proof')
        
        // commit with bounty
        const commitReceipt = await utils.commit(params, outpoint, bounty)
        await utils.timeToClaim(txHash)
        expectEventClaim(await utils.claim(commitReceipt), recipient, rewardWithBounty, payer, memoHash)
      }
    })
  })

  function expectEventClaim(receipt, recipient, reward, payer, memoHash) {
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
    expectEvent(receipt, 'Rewarded', {
      memoHash,
      payer,
      miner: recipient,
      value: reward.toString(),
    });
  }

  async function mineSomeCoin() {
    const {miner} = await mine('42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1')
    return miner
  }

  async function mine(txHash) {
    const commitReceipt = await utils.commitTx(txHash)
    await utils.timeToClaim(txHash)
    const txData = txs[txHash]
    const miner = keys.find(k => k.address == txData.miner)
    await instPoR.registerMiner('0x'+miner.public, ZERO_ADDRESS) // register and set the recipient
    return {
      claimReceipt: utils.claim(commitReceipt),
      miner,
    };
  }
})

