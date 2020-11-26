const _ = require('lodash');
const hash256 = require('../vendor/hash256');
const merkle = require('../vendor/merkle');
const bitcoinjs = require('bitcoinjs-lib');
const { blocks, txs } = require('../data/por');
const { decShift } = require('../../tools/lib/big');
const { time } = require('@openzeppelin/test-helpers');

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
    const {params, outpoint} = this.prepareCommit({txHash, brand});
    return instPoR.commit(params, outpoint)
  },

  extractTxParams(hex, tx) {
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
    const vin = '0x'+hex.substring(vinStart, pos);
    const vout = '0x'+hex.substring(pos, hex.length - 8); // the last 8 bytes is lock time
    return [tx.version, vin, vout, tx.locktime];
  },

  timeToClaim(txHash) {
    const txData = txs[txHash]
    const block = bitcoinjs.Block.fromHex(blocks[txData.block].substring(0, 160));
    return time.increaseTo(block.timestamp + 60*60);
  },

  prepareCommit(txParams, outpointParams) {
    const params = this._prepareCommitTx(txParams)
    if (params.pubkeyPos) {
      var outpoint = []
    } else {
      var outpoint = this._prepareOutpointTx({...outpointParams, txHash: txParams.txHash})
    }
    return {params, outpoint}
  },

  _prepareCommitTx({txHash, brand, payer=ZERO_ADDRESS, inputIndex=0, pubkeyPos}) {
    const txData = txs[txHash];
    const block = bitcoinjs.Block.fromHex(blocks[txData.block]);
    const [merkleProof, merkleIndex] = getMerkleProof(block, txHash);

    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    expect(tx.getId()).to.equal(txHash, 'tx data and hash mismatch');
    const [version, vin, vout, locktime] = this.extractTxParams(txData.hex, tx);

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

    if (pubkeyPos == null) {
      pubkeyPos = findPubKeyPos(tx.ins[inputIndex].script)

      function findPubKeyPos(script) {
        const sigLen = script[0];
        if (script[sigLen+1] != 33) {
          return 0 // not a pubkey
        }
        // expect(script[sigLen+1]).to.equal(33, 'should pubkey length prefix byte is 33');
        return sigLen+2;
      }
    }
 
    return {
      header: '0x'+blocks[txData.block].substring(0, 160),
      merkleIndex,
      merkleProof,
      version: parseInt(version.toString(16).pad(8).reverseHex(), 16),
      locktime: parseInt(locktime.toString(16).pad(8).reverseHex(), 16),
      vin, vout,
      memoLength,
      inputIndex,
      pubkeyPos,
      payer,
    }
  },

  _prepareOutpointTx({txHash, inputIdx=0, pkhPos=0, dxHash}) {
    const txData = txs[txHash];
    const tx = bitcoinjs.Transaction.fromHex(txData.hex);

    const script = tx.ins[inputIdx].script
    if (script && script.length > 0) {
      if (script.length == 23 && script.slice(0, 3).toString('hex') == '160014') {
        // redeem script for P2SH-P2WPKH
        return []
      }
      if (script.length >= 33+4 && script[script.length-33-4-1] === 0x21) {
        // redeem script for P2PKH
        return []
      }
      console.error(script.length)
      console.error(script.toString('hex'))
    }

    dxHash = dxHash || tx.ins[inputIdx].hash.reverse().toString('hex');
    // dependency tx
    const dxMeta = txs[dxHash];
    if (!dxMeta) {
      return [] // there's no data for dx here
    }
    const [version, vin, vout, locktime] = this.extractTxParams(dxMeta.hex);

    return [{
      version: parseInt(version.toString(16).pad(8).reverseHex(), 16),
      locktime: parseInt(locktime.toString(16).pad(8).reverseHex(), 16),
      vin, vout,
      pkhPos,
    }]
  },

  claim(txData, brandHash) {
    return instPoR.claim('0x' + txData.block, brandHash);
  },

  claimWithPrevTx(txData, brandHash, {inputIdx, pkhPos, dxHash} = {}) {
    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    dxHash = dxHash || tx.ins[inputIdx || 0].hash.reverse().toString('hex');

    // dependency tx
    const dxMeta = txs[dxHash];
    const [version, vin, vout, locktime] = this.extractTxParams(dxMeta.hex);

    const extra = {
      version: parseInt(version.toString(16).pad(8).reverseHex(), 16),
      locktime: parseInt(locktime.toString(16).pad(8).reverseHex(), 16),
      pkhPos: pkhPos || 0,
    }

    return instPoR.claimWithPrevTx('0x' + txData.block, brandHash, vin, vout, extra);
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

  getExpectedReward(block, rate = 1) {
    if (_.isString(block)) {
      block = bitcoinjs.Block.fromHex(blocks[block]);
    }
    const MAX_TARGET = 1n<<240n;
    const target = this.bitsToTarget(block.bits)
    return MAX_TARGET / target * BigInt(decShift(rate, 18)) / BigInt(1+'0'.repeat(18));
  },

  bitsToTarget(bits) {
    if (bits > 0xffffffff) {
      throw new Error('"bits" may not be larger than 4 bytes')
    }
    const exponent = bits >>> 24
    if (exponent <= 3) throw new Error('target exponent must be > 3')
    if (exponent > 32) throw new Error('target exponent must be < 32')
    const mantissa = bits & 0x007fffff
    const target = Buffer.alloc(32, 0)
    target.writeUInt32BE(mantissa << 8, 32 - exponent)
    return BigInt('0x' + target.toString('hex'));
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

  return ['0x'+proof, index];
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
