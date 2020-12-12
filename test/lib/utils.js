const _ = require('lodash');
const hash256 = require('../vendor/hash256');
const merkle = require('../vendor/merkle');
const bitcoinjs = require('bitcoinjs-lib');
const { decShift } = require('../../tools/lib/big');
const { time, expectRevert } = require('@openzeppelin/test-helpers');

const { txs, keys } = require('../data/all');

function loadBlockData() {
  const blocks = {}
  const fs = require('fs');
  fs.readdirSync('./test/data/blocks').forEach(blockHash => {
    blocks[blockHash] = fs.readFileSync('./test/data/blocks/'+blockHash).toString()
  });
  return blocks
}
const blocks = loadBlockData()

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
    const Endurio = artifacts.require("Endurio");
    const PoR = artifacts.require("PoR");
    inst = await Endurio.deployed();
    instPoR = await PoR.at(inst.address);
  },

  loadBlockData() {
    return loadBlockData()
  },

  commitTx(txHash, payer, brand) {
    const {params, outpoint, bounty} = this.prepareCommit({txHash, brand, payer});
    return this.commit(params, outpoint, bounty)
  },

  commit(params, outpoint, bounty) {
    if (outpoint.length > 0 && bounty.length == 0) {
      return expectRevert(instPoR.commit(params, [], bounty), '!outpoint')
        .then(() => instPoR.commit(params, outpoint, bounty))
    }
    return instPoR.commit(params, outpoint, bounty)
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

  guessMemo(txHash) {
    const txData = txs[txHash];
    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    const memo = findMemo(tx.outs);
    if (memo.indexOf(' ') > 0) {
      return memo.substring(0, memo.indexOf(' '))
    }
    return memo
  },

  countBounty(txHash) {
    const txData = txs[txHash];
    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    const memoIdx = findMemoIndex(tx.outs)
    return tx.outs.length - memoIdx - 2;
  },

  prepareCommit(txParams, outpointParams, bountyParams) {
    const params = this._prepareCommitTx(txParams)
    if (params.pubkeyPos) {
      var outpoint = []
    } else {
      var outpoint = this._prepareOutpointTx({...outpointParams, txHash: txParams.txHash})
    }
    if (bountyParams && bountyParams.noBounty) {
      var bounty = []
    } else {
      var bounty = this._prepareBountyTx(txParams)
      if (bounty.length > 0) {
        const inputs = bounty[0].inputs.map(i => ({...i, pkhPos: 0}))
        if (outpoint.length > 0) {
          inputs[params.inputIndex].pkhPos = outpoint[0].pkhPos
        }
        outpoint = inputs
        delete bounty[0].inputs
      }
    }
    return {params, outpoint, bounty}
  },

  _prepareBountyTx({txHash}) {
    const txData = txs[txHash]

    // TODO: search for bounty sampling tx instead
    if (!txData.bounty) {
      return []
    }

    const blockData = blocks[txs[txData.bounty].block]
    const [merkleProof, merkleIndex] = getMerkleProof(blockData, txData.bounty);
    const [version, vin, vout, locktime] = this.extractTxParams(txs[txData.bounty].hex);
    const bounty = {
      header: '0x'+blockData.substring(0, 160),
      merkleProof, merkleIndex,
      version: parseInt(version.toString(16).pad(8).reverseHex(), 16),
      locktime: parseInt(locktime.toString(16).pad(8).reverseHex(), 16),
      vin, vout,
      inputs: [],
    }

    const tx = bitcoinjs.Transaction.fromHex(txData.hex)
    for (const input of tx.ins) {
      const [version, vin, vout, locktime] = this.extractTxParams(txs[input.hash.reverse().toString('hex')].hex);
      bounty.inputs.push({
        version: parseInt(version.toString(16).pad(8).reverseHex(), 16),
        locktime: parseInt(locktime.toString(16).pad(8).reverseHex(), 16),
        vin, vout,
      })
    }

    return [bounty]
  },

  _prepareCommitTx({txHash, brand, payer=ZERO_ADDRESS, inputIndex=0, pubkeyPos}) {
    const txData = txs[txHash];
    const block = bitcoinjs.Block.fromHex(blocks[txData.block]);
    const [merkleProof, merkleIndex] = getMerkleProof(block, txHash);

    const tx = bitcoinjs.Transaction.fromHex(txData.hex);
    expect(tx.getId()).to.equal(txHash, 'tx data and hash mismatch');
    const [version, vin, vout, locktime] = this.extractTxParams(txData.hex, tx);

    if (!brand) {
      brand = this.guessMemo(txHash)
    }
    const memoLength = brand.length

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

  claim(commitReceipt) {
    const mined = commitReceipt.logs.find(log => log.event === 'Mined').args
    const pubkey = '0x'+this.minerToClaim(mined).public
    return instPoR.claim(mined.blockHash, mined.memoHash, mined.payer, pubkey, mined.amount, mined.timestamp);
  },

  minerToClaim(mined) {
    if (mined.logs) {
      mined = mined.logs.find(log => log.event === 'Mined').args
    }
    if (mined.pubkey.substring(2+40) == '000000000000000000000000') {
      var key = keys.find(key => key.pkh == mined.pubkey.substring(2, 2+40))
    } else {
      var key = keys.find(key => key.public.startsWith(mined.pubkey.substring(2)))
    }
    if (!key) {
      throw 'missing miner for: ' + mined.pubkey
    }
    return key
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

  getExpectedReward(txHash, rate = 1) {
    const txData = txs[txHash]
    const block = bitcoinjs.Block.fromHex(blocks[txData.block])

    const MAX_TARGET = 1n<<240n;
    const target = this.bitsToTarget(block.bits)
    const base = (MAX_TARGET / target) * BigInt(decShift(rate, 18)) / BigInt(1+'0'.repeat(18))

    if (txData.bounty) {
      var nBounty = this.countBounty(txHash)
      var bounty = MAX_TARGET * BigInt(nBounty*2) / target

      // retargeting
      const bountyBlock = bitcoinjs.Block.fromHex(blocks[txs[txData.bounty].block])
      const bountyTarget = this.bitsToTarget(bountyBlock.bits)
      const targetRate = bountyTarget / target
      if (targetRate >= 2n) {
        var retarget = targetRate
        bounty /= retarget
      }

      // apply rate
      bounty = bounty * BigInt(decShift(rate, 18)) / BigInt(1+'0'.repeat(18))
    }

    return {base, nBounty, bounty, retarget}
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
  const i = findMemoIndex(outs)
  if (i < 0) {
    return
  }
  const script = outs[i].script;
  const len = script[1]
  return script.slice(2, 2 + len).toString()
}

function findMemoIndex(outs) {
  for (let i = 0; i < outs.length; ++i) {
    const script = outs[i].script;
    if (script[0].toString(16) === '6a') { // OP_RET
      return i
    }
  }
  return -1
}

function getMerkleProof(block, txid) {
  if (_.isString(block)) {
    if (block.length < 80) {
      block = blocks[block]
    }
    block = bitcoinjs.Block.fromHex(block)
  }
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
