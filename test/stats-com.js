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

const HIGHEST_ONE = '0x8000000000000000000000000000000000000000000000000000000000000000'

contract("RefNetwork: Commission", accounts => {
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

  const testingTxs = [
    '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
    'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
    '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
    '9da4809c20689edf1874a47f8b9c60adbcd888400eb46b368cd21cdbe2517e5d',
    '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
    '2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
  ]
  const submitReceipts = {}
  const miners = []
  testingTxs.forEach(txHash => {
    const miner = txs[txHash].miner
    if (!miners.includes(miner)) {
      miners.push(miner)
    }
  })

  before('submit all txs', async () => {
    for (const txHash of testingTxs) {
      submitReceipts[txHash] = await utils.submitTx(txHash);
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

    it("root commission", async() => {
      /// RefNetwork.ROOT_COM_RATE
      const ss = await snapshot.take()
      let hit = 0
      for (const txHash in submitReceipts) {
        const submitReceipt = submitReceipts[txHash]
        await utils.timeToClaim(txHash)
        const claimReceipt = await utils.claim(submitReceipt)
        const rootCommission = claimReceipt.logs.find(log => log.event === 'CommissionRoot')
        if (!rootCommission) {
          continue
        }
        ++hit
        const rewarded = claimReceipt.logs.find(log => log.event === 'Claim').args.value
        expectEvent(claimReceipt, 'CommissionRoot', {
          payer: ZERO_ADDRESS,
          miner: txs[txHash].miner,
          value: rewarded,
        })
      }
      console.log(`          + ${hit}/${Object.keys(submitReceipts).length}`)
      await snapshot.revert(ss)
    })

    it("call reward from external", async() => {
      await expectRevert(instRN.reward(ZERO_ADDRESS, ZERO_ADDRESS, 1, ZERO_BYTES32, ZERO_BYTES32, true), '!internal')
    })

    it("commission hit rate", async() => {
      const ss = await snapshot.take()
      await utils.timeToClaim(testingTxs[testingTxs.length-1])

      // first node always the miner
      const noders = ['miner', acc1, acc2, acc3, acc4]

      await expectHitRate([
        { rent:   1, rate: 0.5 },
        { rent:   1, rate: 0.25 },
        { rent:   1, rate: 0.125 },
        { rent:   1, rate: 0.0625 },
        { rent:   1, rate: 0.03125 },
      ])
      await expectHitRate([
        { rent: 0.5, rate: 0.295 },
        { rent: 0.5, rate: 0.205 },
        { rent:   1, rate: 0.25 },
        { rent:   1, rate: 0.125 },
        { rent:   1, rate: 0.0625 },
      ])
      await expectHitRate([
        { rent:   1, rate: 0.5 },
        { rent:   0, rate: 0 },
        { rent:   0, rate: 0 },
        { rent:   1, rate: 0.25 },
        { rent:   1, rate: 0.125 },
      ])
      await expectHitRate([
        { rent:   0, rate: 0 },
        { rent:   1, rate: 0.5 },
        { rent:   0, rate: 0 },
        { rent:   2, rate: 0.375 },
      ])
      await expectHitRate([
        { rent:   1, rate: 0.5 },
        { rent:   2, rate: 0.375 },
      ])
      await expectHitRate([
        { rent:   2, rate: 0.75 },
        { rent:   1, rate: 0.125 },
      ])
      await expectHitRate([
        { rent:   0, rate: 0 },
        { rent:   0, rate: 0 },
        { rent:   0, rate: 0 },
        { rent:   0, rate: 0 },
        { rent:   1, rate: 0.5 },
      ])
      await expectHitRate([
        { rent:   '0.001', rate: 0 },
        { rent:   '0.001', rate: 0 },
        { rent:   '0.001', rate: 0 },
        { rent:   '0.001', rate: 0 },
        { rent:   1, rate: 0.5 },
      ])
      await expectHitRate([
        { rent: 0.1, rate: 0.06696700846 },
        { rent:   2, rate: 0.69977474365 },
        { rent:   0, rate: 0 },
        { rent:   0, rate: 0 },
        { rent:   1, rate: 0.11662912394 },
      ], 30)

      async function expectHitRate(nodes, sampleCount = 10) {
        const ss = await snapshot.take()

        const rates = {}

        { // handle miners as the first node
          const {rent, rate} = nodes[0]
          rates['miner'] = rate
          for (const miner of miners) {
            if (rent) {
              await instRN.update(100000000000, decShift(rent, 3), true, {from: miner})
            }
            await instRN.attach(noders[1], {from: miner})
          }
        }
        for (let i = 1; i < nodes.length; ++i) {
          const {rent, rate} = nodes[i]
          const noder = noders[i]
          if (rent) {
            await instRN.update(100000000000, decShift(rent, 3), true, {from: noder})
          }
          rates[noder] = rate
          if (i+1 < nodes.length) {
            await instRN.attach(noders[i+1], {from: noder})
          }
        }

        const hits = await repeatComHitRate(sampleCount)
        const sampleSize = sampleCount * Object.keys(submitReceipts).length

        let output = '          +'
        for (const noder in rates) {
          const expected = rates[noder]*sampleSize
          const actual = (hits[noder]||0)
          // console.log(`            + ${actual} / ${expected} = ${actual/expected}`)
          if (!expected) {
            output += !!actual ? colors.red(' (xxx)') : ' (---)'
            continue
          }
          const rate = actual/expected
          let r = ` ${rate.toFixed(3)}`
          if (rate < 0.8 || rate > 1.2 ) {
            r = colors.red(r)
          } else if (rate < 0.9 || rate > 1.1 ) {
            r = colors.yellow(r)
          }
          output += r
        }
        console.log(output)

        await snapshot.revert(ss)
      }

      await snapshot.revert(ss)
    })

    async function repeatComHitRate(sampleCount = 10) {
      const globalComRate = (await inst.getGlobalConfig()).comRate
      const allhits = {}
      for (let i = 0; i < sampleCount; ++i) {
        const comRate = globalComRate.add(new BN(i))
        const ss = await snapshot.take()
        await inst.setComRate(comRate)
        const hits = await getComHitRate(comRate)
        for (const payee in hits) {
          allhits[payee] = (allhits[payee]||0) + hits[payee]
        }
        await snapshot.revert(ss)
      }
      return allhits;
    }

    async function getComHitRate(comRate) {
      if (!comRate) {
        comRate = (await inst.getGlobalConfig()).comRate
      }

      const hits = {}

      for (const txHash in submitReceipts) {
        const miner = txs[txHash].miner
        const submitReceipt = submitReceipts[txHash]
        const claimReceipt = await utils.claim(submitReceipt)
        const rewarded = claimReceipt.logs.find(log => log.event === 'Claim').args.value
        const value = rewarded.mul(comRate).div(new BN(1e9))
        const com = claimReceipt.logs.find(log => log.event === 'CommissionPaid')
        if (!com) {
          expectEvent(claimReceipt, 'CommissionLost', { miner, value })
          continue
        }
        let payee = com.args.payee
        expectEvent(claimReceipt, 'CommissionPaid', { miner, payee, value })
        if (utils.addressCompare(payee, miner) === 0) {
          payee = 'miner'
        }
        hits[payee] = (hits[payee]||0) + 1
      }
      return hits
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

