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
        const txData = txs[txHash]
        const blockData = blocks[txData.block]
        const header = blockData.substring(0, 160)
        await instPoR.commitBlock('0x'+header)
        const {block, proofs, extra, vin, vout, memo} = utils.prepareCommitTx(txHash);
        const blockHash = block.getId();
        // enable the bounty flag
        const bountyExtra = '8' + extra.substring(1)
        await instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+bountyExtra, '0x'+vin, '0x'+vout, payer);
        await time.increaseTo(block.timestamp + 60*60)
        const miner = keys.find(k => k.address == txData.miner)
        await instPoR.registerMiner('0x'+miner.public, ZERO_ADDRESS) // register and set the recipient
        const memoHash = web3.utils.keccak256(Buffer.from(memo))

        async function claimIt() {
          const {state} = await instPoR.getWinner('0x'+blockHash, memoHash);
          switch (Number(state)) {
            case 0: throw "tx already claimed"
            case 1: return utils.claim(txData, memoHash);
            case 2: return utils.claimWithPrevTx(txData, memoHash);
            default: throw `unknown TxState: ${state}`
          }
        }

        await expectRevert(claimIt(), 'bounty unclaimed')

        const {opret, script, inputs, params, nBounty} = await instPoR.processBounty('0x'+blockHash, '0x'+vin, '0x'+vout)
        // console.error(opret, script, inputs, params, Number(nBounty))

        const tx = bitcoinjs.Transaction.fromHex(txData.hex);

        // const samplingOutputIdx = new BN(blockHash, 16).mod(new BN(tx.outs.length-2)).toNumber() + 1;
        // console.error(samplingOutputIdx)
        // console.error(tx.outs[samplingOutputIdx].script.toString('hex'))
        // const network = bitcoinjs.networks.testnet
        // console.error(bitcoinjs.address.fromOutputScript(tx.outs[samplingOutputIdx].script, network))

        const words = []
        const buffers = []

        const sample = utils.prepareCommitTx(txData.bounty)

        words.push('0x'+sample.extra)
        buffers.push('0x'+sample.vin, '0x'+sample.vout)

        for (const input of tx.ins) {
          const [version, vin, vout, locktime] = utils.extractTxParams(txs[input.hash.reverse().toString('hex')].hex);
          const extra =
            input.index.toString(16).pad(8) +  // miner input index
            '00000000' +
            locktime.toString(16).pad(8).reverseHex() +
            version.toString(16).pad(8).reverseHex();
          words.push('0x'+extra.pad(64))
          buffers.push('0x'+vin, '0x'+vout)
        }

        words.push(params)
        words.push(memoHash)
        words.push('0x'+blockHash)
        buffers.push('0x'+sample.proofs)                                  // sampling tx merkle proofs
        buffers.push('0x'+blocks[sample.block.getId()].substring(0, 160)) // sampling block header

        console.error(words)
        console.error(buffers)

        // function isHit(txid, recipient) {
        //   const preimage = txid + recipient
        //   const hash = web3.utils.keccak256(Buffer.from(preimage, 'hex'))
        //   return new BN(hash, 16).mod(new BN(RecipientRate)).isZero()
        // }

        // console.error(tx.ins[0])
        // console.error(tx.ins[0].hash.toString('hex'), txData.bounty, isHit(tx.ins[0].hash.toString('hex'), txData.bounty))

        await instPoR.claimBounty(words, buffers)

        const receipt = await claimIt();
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

  async function mine(txHash, payer = ZERO_ADDRESS) {
    const txData = txs[txHash]
    const blockData = blocks[txData.block]
    const header = blockData.substring(0, 160)
    await instPoR.commitBlock('0x'+header)
    const {block, proofs, extra, vin, vout, memo} = utils.prepareCommitTx(txHash);
    const blockHash = block.getId();
    await instPoR.commitTx('0x' + blockHash, '0x' + proofs, '0x' + extra, '0x' + vin, '0x' + vout, payer);
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

