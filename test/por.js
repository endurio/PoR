const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert, BN } = require('@openzeppelin/test-helpers');
const hash256 = require('./vendor/hash256');
const merkle = require('./vendor/merkle');
const { blocks, txs } = require('./data/por');

const ENDR = artifacts.require("ENDR");
const PoR = artifacts.require("PoR");
let inst;
let instPoR;

contract("PoR", accounts => {
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
    expect(await PoR.deployed(), 'contract not deployed: PoR').to.not.be.null
    // proxy implementations
    instPoR = await PoR.at(inst.address)
  });

  describe('mine', () => {
    it("commitBlock", async() => {
      const commitBlocks = [
        '00000000000000532f27676512db71ab780b125cbb7d86db06d74c2ec73ff791',
        '00000000000002152b5fe8c807c4743bb0633d6e1d70f3cc96d5e542ba4ef07a',
      ]
      for (const hash of commitBlocks) {
        const header = blocks[hash].substring(0, 160)
        await instPoR.commitBlock('0x' + header)
        await expectRevert(instPoR.commitBlock('0x' + header), 'block committed')
      }
    })

    it("commitTx", async() => {
      const commitTxs = [
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
      ]
      for (const txHash of commitTxs) {
        const txMeta = txs[txHash];
        const block = bitcoinjs.Block.fromHex(blocks[txMeta.block]);
        const [proofs, idx] = getMerkleProof(block, txHash);

        const tx = bitcoinjs.Transaction.fromHex(txMeta.hex);
        const [version, vin, vout, locktime] = extractTxParams(txMeta.hex, tx);

        const outIdx = findMemoOutputIndex(tx.outs, 'endur.io');
        expect(outIdx, 'mining OP_RET output not found').to.not.be.undefined;

        let extra =
          pad(idx.toString(16), 8) +
          '00000000' +
          '00000000' +
          '00000000' +
          pad((0).toString(16), 8) +
          pad(outIdx.toString(16), 8) +
          pad(reverseUint32(locktime).toString(16), 8) +
          pad(reverseUint32(version).toString(16), 8);

        await instPoR.commitTx('0x' + txMeta.block, '0x' + proofs, '0x' + extra, '0x' + vin, '0x' + vout);

        extra = extra.slice(0, 32) +
          pad((1).toString(16), 8) +  // change the miner input index
          extra.slice(40);

        await instPoR.commitTx('0x' + txMeta.block, '0x' + proofs, '0x' + extra, '0x' + vin, '0x' + vout);
      }
    })
  })
})

function findMemoOutputIndex(outs, brand) {
  for(let i = 0; i < outs.length; ++i) {
    const script = outs[i].script;
    if (script[0].toString(16) === '6a') { // OP_RET
      const len = script[1]
      const memo = script.slice(2, 2+len).toString()
      expect(memo).to.equal(brand, 'unknown memo')
      return i;
    }
  }
}

function pad(s, n) {
  const l = s ? s.length : 0;
  for (let i = l; i < n; ++i) {
    s = '0' + s;
  }
  return s;
}

function reverseUint32(val) {
  return ((val & 0xFF) << 24)
         | ((val & 0xFF00) << 8)
         | ((val >> 8) & 0xFF00)
         | ((val >> 24) & 0xFF);
}

function extractTxParams(hex, tx) {
  tx = tx || bitcoinjs.Transaction.fromHex(hex);

  let vinStart = 8;
  // check the witness flag
  if (hex.substring(8, 2) === '00') {
    vinStart += 4; // 2 more bytes for witness flag
  }

  // lazily assume that the last input sequence hex is unique
  const lastSequence = tx.ins[tx.ins.length-1].sequence.toString(16);
  const pos = hex.lastIndexOf(lastSequence);
  expect(pos).to.be.at.least(0, 'last input sequence hex not found');
  const voutStart = pos + lastSequence.length;

  const vin = hex.substring(vinStart, voutStart);
  const vout = hex.substring(voutStart, hex.length - 8); // the last 8 bytes is lock time
  return [tx.version, vin, vout, tx.locktime];
}

function getMerkleProof(block, txid) {
  let index = -1;
  const txs = [];
  for (const [i, tx] of Object.entries(block.transactions)) {
    if (tx.getId() === txid) { index = i >>> 0; } // cast to uint from string
    txs.push(Buffer.from(tx.getId(), 'hex').reverse());
  }

  expect(index).to.be.at.least(0, 'Transaction not in block.');

  const [root] = merkle.createRoot(hash256, txs.slice());
  expect(block.merkleRoot.toString('hex')).to.equal(root.toString('hex'), 'merkle root mismatch');

  const branch = merkle.createBranch(hash256, index, txs.slice());

  let proof = '';
  for (const hash of branch) {
    proof += hash.toString('hex');
  }

  return [proof, index];
}
