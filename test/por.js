const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert } = require('@openzeppelin/test-helpers');
const hash256 = require('./vendor/hash256');
const merkle = require('./vendor/merkle');
const snapshot = require('./lib/snapshot');
const { keys, blocks, txs } = require('./data/por');

const ENDR = artifacts.require("ENDR");
const PoR = artifacts.require("PoR");
let inst;
let instPoR;

const memo = 'endur.io';
const memoHash = '022086784c27d04e67d08b0afbf4f0459c59a00094bd15dab852f4fa981d2147'; // KECCAK('endur.io')

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
        '000000000000009cc9cc0d820f060f3c7dd868162f5fdfba0dfc2050fb0bda68',
        '00000000000000532f27676512db71ab780b125cbb7d86db06d74c2ec73ff791',
        '00000000000002152b5fe8c807c4743bb0633d6e1d70f3cc96d5e542ba4ef07a',
      ]
      for (const hash of commitBlocks) {
        const header = blocks[hash].substring(0, 160)
        await instPoR.commitBlock('0x'+header)
        await expectRevert(instPoR.commitBlock('0x'+header), 'block committed')
      }
    })

    it("commitTx", async() => {
      const commitTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
      ]
      for (const txHash of commitTxs) {
        const txMeta = txs[txHash];
        const block = bitcoinjs.Block.fromHex(blocks[txMeta.block]);
        const [proofs, idx] = getMerkleProof(block, txHash);

        const tx = bitcoinjs.Transaction.fromHex(txMeta.hex);
        const [version, vin, vout, locktime] = extractTxParams(txMeta.hex, tx);

        const outIdx = findMemoOutputIndex(tx.outs, memo);
        expect(outIdx, 'mining OP_RET output not found').to.not.be.undefined;

        let extra =
          idx.toString(16).pad(8) +
          '00000000' +
          '00000000' +
          '00000000' +
          (1).toString(16).pad(8) +
          outIdx.toString(16).pad(8) +
          locktime.toString(16).pad(8).reverseHex() +
          version.toString(16).pad(8).reverseHex();

        if (tx.ins.length > 1) {
          await instPoR.commitTx('0x'+txMeta.block, '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout);
        }

        extra = extra.slice(0, 32) +
          (0).toString(16).pad(8) +  // change the miner input index
          extra.slice(40);

        await instPoR.commitTx('0x'+txMeta.block, '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout);
      }
    })

    it("registerMiner", async() => {
      for (const key of keys) {
        await expectRevert(
          instPoR.registerMiner('0x'+key.public, '0x0123456789012345678901234567890123456789'),
          "only pkh owner can change the beneficient address");
        await instPoR.registerMiner('0x'+key.public, '0x0000000000000000000000000000000000000000');
      }
    })

    it("changeMiner", async() => {
      for (const key of keys) {
        await expectRevert(
          instPoR.changeMiner('0x'+key.pkh, '0x0123456789012345678901234567890123456789'),
          "only for old owner");
      }
    })

    it("claim", async() => {
      const commitTxs = [
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
      ]

      { // scope in
        const txHash = commitTxs[0];
        const txMeta = txs[txHash];
        await expectRevert(claim(txMeta, 0), "mining time not over");
      }

      for (const txHash of commitTxs) {
        const txMeta = txs[txHash];

        const block = bitcoinjs.Block.fromHex(blocks[txMeta.block]);
        await time.increaseTo(block.timestamp + 60*60);

        // PKH never be in the start of the output script
        await expectRevert(claim(txMeta, 0, 10), "unregistered PKH");

        // auto detect PKH position
        const ss = await snapshot.take();
        await claim(txMeta, 0);

        await snapshot.revert(ss);
        // PKH position in output script is different between segwit and legacy
        const isSegWit = txMeta.hex.slice(8, 10) === '00';
        await claim(txMeta, 0, isSegWit ? 11 : 12);
      }

      function claim(txMeta, inputIdx, pkhPos) {
        const tx = bitcoinjs.Transaction.fromHex(txMeta.hex);
        const dxHash = tx.ins[inputIdx].hash.reverse().toString('hex');

        // dependency tx
        const dxMeta = txs[dxHash];
        const [version, vin, vout, locktime] = extractTxParams(dxMeta.hex);

        extra =
          locktime.toString(16).pad(8).reverseHex() +
          version.toString(16).pad(8).reverseHex();

        if (pkhPos) {
          extra = pkhPos.toString(16).pad(8) + extra
        }
        extra = extra.pad(64);

        return instPoR.claim('0x'+txMeta.block, '0x'+memoHash, '0x'+vin, '0x'+vout, '0x'+extra);
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

if (!String.prototype.pad) {
  Object.defineProperty(String.prototype, 'pad', {
    enumerable: false,
    value: function(n) {
      if (this.length >= n) {
        return this;
      }
      return '0'.repeat(n-this.length) + this;
    },
  });
}

if (!String.prototype.reverseHex) {
  Object.defineProperty(String.prototype, 'reverseHex', {
    enumerable: false,
    value: function() {
      const s = this.replace(/^(.(..)*)$/, "0$1");  // add a leading zero if needed
      const a = s.match(/../g);                     // split number in groups of two
      a.reverse();                                  // reverse the groups
      return a.join('');                            // join the groups back together
    },
  });
}

function stripTxWitness(hex, tx) {
  tx = tx || bitcoinjs.Transaction.fromHex(hex);
  const isSegWit = hex.slice(8, 10) === '00';
  if (!isSegWit) {
    return hex;
  }

  // remove segwit marker and flag
  hex = hex.slice(0, 8) + hex.slice(12);
  // remove all witness data
  let pos = 0;
  for (const input of tx.ins) {
    for (const w of input.witness) {
      if (w.length <= 0) {
        continue;
      }
      const witness = w.toString('hex');
      pos = hex.indexOf(witness, pos);
      expect(pos).to.be.at.least(0, `witness not found: ${witness}`);
      expect(parseInt(hex.slice(pos-2, pos), 16)).to.equal(w.length, 'witness length prefix mismatch');
      hex = hex.slice(0, pos-2) + hex.slice(pos + witness.length);
    }
  }
  // remove 1-byte of 'number of witnesses'
  hex = hex.slice(0, hex.length-10) + hex.slice(hex.length-8);
  return hex;
}

function extractTxParams(hex, tx) {
  tx = tx || bitcoinjs.Transaction.fromHex(hex);
  hex = stripTxWitness(hex, tx);

  // lazily assume that the last input sequence hex is unique
  const lastSequence = tx.ins[tx.ins.length-1].sequence.toString(16).pad(8).reverseHex();
  const pos = hex.lastIndexOf(lastSequence);
  expect(pos).to.be.at.least(0, `last input sequence hex not found: ${lastSequence}`);
  const voutStart = pos + lastSequence.length;

  const vinStart = 8; // 2 more bytes for witness flag
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
