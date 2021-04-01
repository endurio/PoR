const _ = require('lodash');
const hash256 = require('../vendor/hash256');
const merkle = require('../vendor/merkle');
const bitcoinjs = require('bitcoinjs-lib');
const { decShift } = require('../../tools/lib/big');
const { time, expectRevert } = require('@openzeppelin/test-helpers');
const ethers = require('ethers')

const { txs, keys } = require('../data/all');

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

function loadBlockData() {
  const blocks = {}
  const fs = require('fs');
  fs.readdirSync('./test/data/blocks').forEach(blockHash => {
    blocks[blockHash] = fs.readFileSync('./test/data/blocks/'+blockHash).toString()
  });
  fs.readdirSync('./test/data/block').forEach(blockHash => {
    const block = JSON.parse(fs.readFileSync('./test/data/block/'+blockHash))
    // block.transactions = block.txs
    const { time, mrkl_root, prev_block, ver, ...remain } = block
    blocks[blockHash] = {
      timestamp: new Date(time).getTime(),
      merkleRoot: mrkl_root.reverseHex(),
      prevBlock: prev_block.reverseHex(),
      version: ver,
      ...remain,
    }
  });
  return blocks
}
const blocks = loadBlockData()

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

var inst;
var instPoR;

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

  getBlock(hash) {
    const data = blocks[hash]
    if (typeof data === 'string') {
      return bitcoinjs.Block.fromHex(data)
    }
    return data
  },

  getHeader(hash) {
    const data = blocks[hash]
    if (typeof data === 'string') {
      return data.substring(0, 160)
    }
    return _extractHeader(data)
    function _extractHeader(block) {
      const { version, prevBlock, merkleRoot, timestamp, bits, nonce } = block
      return ''.concat(
        nonce.toString(16).padStart(8, '0'),
        bits.toString(16).padStart(8, '0'),
        timestamp.toString(16).padStart(8, '0'),
        merkleRoot.reverseHex(),
        prevBlock.reverseHex(),
        version.toString(16).padStart(8, '0'),
      ).reverseHex()
    }
  },

  submitTx(txHash, payer, brand) {
    const {params, outpoint, bounty} = this.prepareSubmit({txHash, brand, payer});
    return this.submit(params, outpoint, bounty)
  },

  submit(params, outpoint, bounty) {
    if (outpoint.length > 0 && bounty.length == 0) {
      return expectRevert(instPoR.submit(params, [], bounty), '!outpoint')
        .then(() => instPoR.submit(params, outpoint, bounty))
    }
    return instPoR.submit(params, outpoint, bounty)
  },

  extractTxParams(hex, tx) {
    tx = tx || bitcoinjs.Transaction.fromHex(hex);
    hex = stripTxWitness(hex);
    expect(bitcoinjs.Transaction.fromHex(hex).getId()).to.equal(tx.getId(), 'bad code: stripTxWitness');
  
    const sequence = tx.ins[tx.ins.length-1].sequence.toString(16).padStart(8, '0').reverseHex()
    const nOuts = tx.outs.length.toString(16).padStart(2,'0')  // assume that nOuts fits in 1 byte
    const value = tx.outs[0].value.toString(16).padStart(16, '0').reverseHex()
    let voutStart = hex.indexOf(sequence + nOuts + value)
    if (voutStart < 0) {
      throw 'parsing transaction vin/vout failed'
    }
    voutStart += 8  // 4 bytes sequence  
  
    let vinStart = 8; // 4 bytes version
    if (hex.substr(8, 2) == '00') {
      vinStart += 4   // 2 more bytes for witness flag
    }
  
    const vin = '0x'+hex.substring(vinStart, voutStart);
    const vout = '0x'+hex.substring(voutStart, hex.length - 8); // the last 8 bytes is lock time
    return [tx.version, vin, vout, tx.locktime];
  },

  async timeToClaim(txHash) {
    const txData = txs[txHash]
    const block = bitcoinjs.Block.fromHex(blocks[txData.block].substring(0, 160));
    const target = block.timestamp + 2*60*60
    if (await time.latest() < target) {
      return time.increaseTo(target)
    }
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

  prepareSubmit(txParams, outpointParams, bountyParams) {
    const params = this._prepareSubmitTx(txParams)
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

    const blockData = this.getBlock(txs[txData.bounty].block)
    const [merkleProof, merkleIndex] = getMerkleProof(blockData, txData.bounty);
    const [version, vin, vout, locktime] = this.extractTxParams(txs[txData.bounty].hex);
    const bounty = {
      header: '0x'+this.getHeader(txs[txData.bounty].block),
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

  _prepareSubmitTx({txHash, brand, payer=ZERO_ADDRESS, inputIndex=0, pubkeyPos}) {
    const txData = txs[txHash];
    const block = this.getBlock(txData.block);
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
      header: '0x'+this.getHeader(txData.block),
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

  claim(submitReceipt) {
    const mined = submitReceipt.logs.find(log => log.event === 'Submit').args
    const key = this.minerToClaim(mined)
    const params = this.paramsToClaim(mined)
    return instPoR.claim(params, {from: key.address});
  },

  paramsToClaim(mined) {
    if (mined.logs) {
      mined = mined.logs.find(log => log.event === 'Submit').args
    }
    const { blockHash, memoHash, pkc, payer, value, timestamp } = mined;
    const key = this.minerToClaim(mined)
    const params = {
      blockHash, memoHash, payer,
      amount: value.toString(),
      timestamp: timestamp.toString(),
      pkc,
      pubkey: '0x'+key.public,
      skipCommission: false,
    }
    return params;
  },

  isPKH(mined) {
    if (mined.logs) {
      mined = mined.logs.find(log => log.event === 'Submit').args
    }
    return mined.pkc.substring(2+40) == '000000000000000000000000'
  },

  minerToClaim(mined) {
    if (mined.logs) {
      mined = mined.logs.find(log => log.event === 'Submit').args
    }
    if (this.isPKH(mined)) {
      var key = keys.find(key => key.pkh == mined.pkc.substring(2, 2+40))
    } else {
      var key = keys.find(key => this.pkk(key.public) == mined.pkc)
    }
    if (!key) {
      throw 'missing miner for: ' + mined.pubkey
    }
    return key
  },

  nonMinerToClaim(mined) {
    if (mined.logs) {
      mined = mined.logs.find(log => log.event === 'Submit').args
    }
    if (this.isPKH(mined)) {
      var key = keys.find(key => key.pkh != mined.pkc.substring(2, 2+40))
    } else {
      var key = keys.find(key => this.pkk(key.public) != mined.pkc)
    }
    if (!key) {
      throw 'missing non-miner for: ' + mined.pubkey
    }
    return key
  },

  extractWitness(txHash) {
    const tx = bitcoinjs.Transaction.fromHex(txs[txHash].hex)
    for (let i = 0; i < tx.ins.length; ++i) {
      try {
        var { sig, pubkey, hash } = extractInputWitness(tx, 0)
        break
      } catch(err) {
        console.error(err)
      }
    }
    if (!sig) {
      return
    }
    const R = sig.signature.slice(0, 32)
    const S = sig.signature.slice(32)

    for (const v of [27, 28]) {
      const pk = ethers.utils.recoverPublicKey(hash, {
        v,
        r: '0x'+R.toString('hex'),
        s: '0x'+S.toString('hex'),
      })
      if (pk.substr(4, 64) == pubkey.toString('hex').substr(2, 64)) {
        return Buffer.concat([hash, Buffer.from([v]), sig.signature])
      }
    }
    return
  },

  // public key keccak
  pkk(pubkey) {
    const lastByte = parseInt(pubkey.substr(pubkey.length-2), 16)
    const prefix = (lastByte & 1) ? '0x03' : '0x02'
    const cpk = prefix + this.strip0x(pubkey).substr(0, 64)
    return web3.utils.keccak256(cpk)
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
    const block = this.getBlock(txData.block)

    const MAX_TARGET = 1n<<240n;
    const target = this.bitsToTarget(block.bits)
    const base = (MAX_TARGET / target) * BigInt(decShift(rate, 18)) / BigInt(1+'0'.repeat(18))

    if (txData.bounty) {
      var nBounty = this.countBounty(txHash)
      var bounty = MAX_TARGET * BigInt(nBounty*2) / target

      // retargeting
      const bountyBlock = this.getBlock(txs[txData.bounty].block)
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
  if (block.txids) {
    var txs = block.txids.map(hash => Buffer.from(hash, 'hex').reverse())
    var index = block.txids.findIndex(hash => hash == txid)
  } else {
    var txs = []
    for (const [i, tx] of Object.entries(block.transactions)) {
      if (tx.getId() === txid) { var index = i >>> 0; } // cast to uint from string
      txs.push(Buffer.from(tx.getId(), 'hex').reverse());
    }
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

function extractInputWitness(tx, i) {
	const input = tx.ins[i]
	// console.log(`\tinput`, input)
	const { sig, pubkey } = extractInputSignature(input)
	if (!sig || !pubkey) {
		throw 'unable to extract signature and pubkey from input'
	}
	if (!sig) {
		throw 'no signature'
	}

	// input tx hash is recorded reversed in the tx binary
	const inputTxHash = Buffer.alloc(input.hash.length, input.hash, 'hex').reverse().toString('hex')
	if (!txs[inputTxHash]) {
		throw 'prev output tx unavailable: ' + inputTxHash
	}
	const dxHex = txs[inputTxHash].hex
	const dx = bitcoinjs.Transaction.fromHex(dxHex)
	const prevOut = dx.outs[input.index]

	if (input.script.length > 0) {
		var hash = tx.hashForSignature(i, prevOut.script, sig.hashType)
	} else {
		const signingScript = bitcoinjs.payments.p2pkh({ hash: prevOut.script.slice(2) }).output;
		var hash = tx.hashForWitnessV0(i, signingScript, prevOut.value, sig.hashType)
	}

  // verify the correctness
  const keyPair = bitcoinjs.ECPair.fromPublicKey(pubkey);
  if (!keyPair.verify(hash, sig.signature)) {
    throw 'unsupported transaction type'
  }

	return { sig, pubkey, hash }

  function extractInputSignature(input) {
    if (input.witness.length > 0) {
      var chunks = input.witness
      var itemName = 'script chunk'
    } else {
      var chunks = bitcoinjs.script.decompile(input.script)
      var itemName = 'witness'
    }
    const ret = {}
    for (const chunk of chunks) {
      if (Buffer.isBuffer(chunk) && bitcoinjs.script.isCanonicalScriptSignature(chunk)) {
        ret.sig = bitcoinjs.script.signature.decode(chunk)
      } else if (Buffer.isBuffer(chunk) && bitcoinjs.script.isCanonicalPubKey(chunk)) {
        ret.pubkey = chunk
      } else {
        console.log(`ignore unknown ${itemName}`, web3.utils.bytesToHex(chunk))
      }
    }
    return ret
  }
}
