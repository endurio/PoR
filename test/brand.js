require('it-each')({ testPerIteration: true });
const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert, expectEvent, BN } = require('@openzeppelin/test-helpers');
const snapshot = require('./lib/snapshot');
const { keys, blocks, txs } = require('./data/por');
const utils = require('./lib/utils');

const ENDR = artifacts.require("ENDR");
const PoR = artifacts.require("PoR");
const RefNetwork = artifacts.require("RefNetwork");
const BrandMarket = artifacts.require("BrandMarket");
let inst;
let instPoR;
let instRN;
let instBM;

const ENDURIO = Buffer.from('endur.io');
const ENDURIO_HASH = '0x022086784c27d04e67d08b0afbf4f0459c59a00094bd15dab852f4fa981d2147';  // KECCAK('endur.io')

const FOOBAR = Buffer.from('foobar');
const FOOBAR_HEX = '0x'+FOOBAR.toString('hex');
const FOOBAR_HASH = '0x38d18acb67d25c8bb9942764b62f18e17054f66a817bd4295423adf9ed98873e';   // KECCAK('foobar')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

contract("BrandMarket", accounts => {
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

  describe('brand management', () => {
    it("mine some coin", async() => {
      const key = await mineSomeCoin()
      expect(utils.addressCompare(key.address, sender.address)).to.equal(0, "should the miner address is the truffle test account")
      const balance = await inst.balanceOf(sender.address)
      expect(balance).to.be.bignumber.equal(new BN(274882101312), "should some coin be mined")
    })
  })
  function mineSomeCoin() {
    return mine('42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1')
  }

  async function mine(txHash) {
    const txData = txs[txHash]
    const blockData = blocks[txData.block]
    const block = bitcoinjs.Block.fromHex(blockData)
    const header = blockData.substring(0, 160)
    await instPoR.commitBlock('0x'+header)
    await utils.commitTx(txHash, ENDURIO)
    await time.increaseTo(block.timestamp + 60*60)
    const miner = keys.find(k => k.address == txData.miner)
    await instPoR.registerMiner('0x'+miner.public, ZERO_ADDRESS) // register and set the recipient        
    await utils.claimWithPrevTx(txData, ENDURIO_HASH)
    return miner;
  }
})
