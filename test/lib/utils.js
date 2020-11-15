const hash256 = require('../vendor/hash256');
const merkle = require('../vendor/merkle');
const bitcoinjs = require('bitcoinjs-lib');
const { blocks, txs } = require('../data/por');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

var inst;
var instPoR;

if (!String.prototype.pad) {
  Object.defineProperty(String.prototype, 'pad', {
    enumerable: false,
    value: function (n) {
      if (this.length >= n) {
        return this;
      }
      return '0'.repeat(n - this.length) + this;
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

module.exports = {
  async initialize() {
    const ENDR = artifacts.require("ENDR");
    const PoR = artifacts.require("PoR");
    inst = await ENDR.deployed();
    instPoR = await PoR.at(inst.address);
  },

  commitTx(txHash, brand) {
    const {block, proofs, extra, vin, vout} = this.prepareCommitTx(txHash, brand);
    const blockHash = block.getId();
    return instPoR.commitTx('0x' + blockHash, '0x' + proofs, '0x' + extra, '0x' + vin, '0x' + vout, ZERO_ADDRESS);
  },

  prepareCommitTx(txHash, brand) {
    const txData = txs[txHash];
    const block = bitcoinjs.Block.fromHex(blocks[txData.block]);
    const [proofs, idx] = getMerkleProof(block, txHash);

    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    expect(tx.getId()).to.equal(txHash, 'tx data and hash mismatch');
    const [version, vin, vout, locktime] = extractTxParams(txData.hex, tx);

    let memo = findMemo(tx.outs)
    let memoLength = 0;
    if (memo) {
      if (brand) {
        expect(memo.slice(0, brand.length)).to.equal(brand.toString(), 'unknown memo')
        memoLength = memo.length > brand.length ? brand.length : 0;
      } else {
        if (memo.indexOf(' ') > 0) {
          memo = memo.substring(0, memo.indexOf(' '))
          memoLength = memo.length
        }
      }
    }

    let extra =
      '00000000' +
      '00000000' +
      '00000000' +  // compressed PK position
      (memoLength).toString(16).pad(8) +
      '00000000' +  // miner input index
      idx.toString(16).pad(8) +   // merkle index
      locktime.toString(16).pad(8).reverseHex() +
      version.toString(16).pad(8).reverseHex();

    return {block, proofs, extra, vin, vout, memo};
  },

  claim(txData, brandHash) {
    return instPoR.claim('0x' + txData.block, brandHash);
  },

  claimWithPrevTx(txData, brandHash, {inputIdx, pkhPos, dxHash} = {}) {
    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    dxHash = dxHash || tx.ins[inputIdx || 0].hash.reverse().toString('hex');

    // dependency tx
    const dxMeta = txs[dxHash];
    const [version, vin, vout, locktime] = extractTxParams(dxMeta.hex);

    let extra =
      locktime.toString(16).pad(8).reverseHex() +
      version.toString(16).pad(8).reverseHex();
    extra = extra.pad(64);

    if (pkhPos) {
      extra = setPKHPos(extra, pkhPos)
    }

    return instPoR.claimWithPrevTx('0x' + txData.block, brandHash, '0x' + vin, '0x' + vout, '0x' + extra);

    function setPKHPos(extra, pkhPos) {
      return extra.slice(0, 8*2) +
        (pkhPos).toString(16).pad(8) +
        extra.slice(8*3);
    }
  },

  addressCompare(a, b) {
    if (!a) {
        return !b
    }
    return this.strip0x(a).localeCompare(this.strip0x(b), undefined, {sensitivity: 'accent'})
  },

  strip0x(a) {
    if (a && a.startsWith('0x')) {
        return a.substring(2)
    }
    return a
  },
}

function findMemo(outs) {
  for (let i = 0; i < outs.length; ++i) {
    const script = outs[i].script;
    if (script[0].toString(16) === '6a') { // OP_RET
      const len = script[1]
      const memo = script.slice(2, 2 + len).toString()
      return memo
    }
  }
}

function getMerkleProof(block, txid) {
  let index = -1;
  const txs = [];
  for (const [i, tx] of Object.entries(block.transactions)) {
    if (tx.getId() === txid) { index = i >>> 0; } // cast to uint from string
    txs.push(Buffer.from(tx.getId(), 'hex').reverse());
  }

  expect(index).to.be.at.least(0, 'tx not found');

  const [root] = merkle.createRoot(hash256, txs.slice());
  expect(block.merkleRoot.toString('hex')).to.equal(root.toString('hex'), 'merkle root mismatch');

  const branch = merkle.createBranch(hash256, index, txs.slice());

  let proof = '';
  for (const hash of branch) {
    proof += hash.toString('hex');
  }

  return [proof, index];
}

function stripTxWitness(hex) {
  tx = bitcoinjs.Transaction.fromHex(hex);
  if (!tx.hasWitnesses()) {
    return hex;
  }
  for (let i = 0; i < tx.ins.length; ++i) {
    tx.setWitness(i, []);
  }
  return tx.toHex();
}

function extractTxParams(hex, tx) {
  tx = tx || bitcoinjs.Transaction.fromHex(hex);
  hex = stripTxWitness(hex);
  expect(bitcoinjs.Transaction.fromHex(hex).getId()).to.equal(tx.getId(), 'bad code: stripTxWitness');

  // lazily assume that the each input sequence hex is unique
  let pos = 0;
  for (const input of tx.ins) {
    const sequence = input.sequence.toString(16).pad(8).reverseHex()
    pos = hex.indexOf(sequence, pos);
    expect(pos).to.be.at.least(0, `input sequence not found: ${sequence}`);
    pos += 8;
  }

  const vinStart = 8; // 2 more bytes for witness flag
  const vin = hex.substring(vinStart, pos);
  const vout = hex.substring(pos, hex.length - 8); // the last 8 bytes is lock time
  return [tx.version, vin, vout, tx.locktime];
}
