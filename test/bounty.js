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

const ENDURIO = Buffer.from('endur.io');
const ENDURIO_HASH = web3.utils.keccak256(ENDURIO);
const FOOBAR = Buffer.from('foobar');
const FOOBAR_HASH = web3.utils.keccak256(FOOBAR);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const RecipientRate = 32;

contract("PoR: Bounty Hunter", accounts => {
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

    it("activate new brand 'foobar'", async() => {
      const fund = 200000000000;
      const payRate = 0.01;
      await instBM.activate(FOOBAR, fund, decShift(payRate, 18), 0)
    })

    it("mine the txs", async() => {
      const payRate = 0.01;
      const payer = sender.address;

      const commitTxs = [
        // 'e79262b32f1514104ba1895ab881c62f11e355bd449d0918180dc86e2b184d09',
        '73d229d9ca76efaf53d9fd1f361f054155d15b7d38244c9eaa2e292f6bc243f2',
      ]

      for (const txHash of commitTxs) {
        const memo = utils.guessMemo(txHash)
        const memoHash = web3.utils.keccak256(Buffer.from(memo))

        const commitReceipt = await utils.commitTx(txHash, payer)
        await utils.timeToClaim(txHash)

        const txData = txs[txHash]
        const miner = keys.find(k => k.address == txData.miner)
        await instPoR.registerMiner('0x'+miner.public, ZERO_ADDRESS) // register and set the recipient

        await utils.claim(commitReceipt)

        // const samplingOutputIdx = new BN(blockHash, 16).mod(new BN(tx.outs.length-2)).toNumber() + 1;
        // console.error(samplingOutputIdx)
        // console.error(tx.outs[samplingOutputIdx].script.toString('hex'))
        // const network = bitcoinjs.networks.testnet
        // console.error(bitcoinjs.address.fromOutputScript(tx.outs[samplingOutputIdx].script, network))

        continue
        const recipient = miner.address
        const reward = utils.getExpectedReward(txData.block, payRate)
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
  })

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

