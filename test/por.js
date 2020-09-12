const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { expect } = require('chai');
const { time, expectRevert, expectEvent } = require('@openzeppelin/test-helpers');
const hash256 = require('./vendor/hash256');
const merkle = require('./vendor/merkle');
const snapshot = require('./lib/snapshot');
const { keys, blocks, txs } = require('./data/por');

const ENDR = artifacts.require("ENDR");
const PoR = artifacts.require("PoR");
let inst;
let instPoR;

const ENDURIO = 'endur.io';
const ENDURIO_HEX = '656e6475722e696f000000000000000000000000000000000000000000000000';
const ENDURIO_HASH = '022086784c27d04e67d08b0afbf4f0459c59a00094bd15dab852f4fa981d2147'; // KECCAK('endur.io')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DUMMY_ADDRESS = '0x0123456789012345678901234567890123456789';

contract("PoR", accounts => {
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
    expect(await PoR.deployed(), 'contract not deployed: PoR').to.not.be.null
    // proxy implementations
    instPoR = await PoR.at(inst.address)
  });

  describe('mine', () => {
    it("commitBlock", async() => {
      const commitBlocks = [
        '00000000000002152b5fe8c807c4743bb0633d6e1d70f3cc96d5e542ba4ef07a',
        '00000000000000532f27676512db71ab780b125cbb7d86db06d74c2ec73ff791',
        '000000000000009cc9cc0d820f060f3c7dd868162f5fdfba0dfc2050fb0bda68',
        '00000000000000553dea07bc6e4e48a03c02bd46af124307ffb065e7e97e0c76',
        '000000000000024e0d7c55d4fdff24c031544f93df465870b4060f095ae60589',
      ]

      for (const hash of commitBlocks) {
        const raw = blocks[hash];
        const header = raw.substring(0, 160)
        const block = bitcoinjs.Block.fromHex(raw)

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60-30) // give the chain 30s tolerance
          await instPoR.commitBlock('0x'+header)
          await snapshot.revert(ss);
        }

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60)
          await expectRevert(instPoR.commitBlock('0x'+header), 'block too old')
          await snapshot.revert(ss);
        }

        await instPoR.commitBlock('0x'+header)
        await expectRevert(instPoR.commitBlock('0x'+header), 'block committed')

        // bad block header
        const badHeader = header.slice(0, header.length-8) + '00000000'; // clear the nonce field
        await expectRevert(instPoR.commitBlock('0x'+badHeader), 'insufficient work')
      }
    })

    it("commitTx competition", async() => {
      const losingTx = 'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a'
      const winingTx = 'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78' // intentional typo

      const ss = await snapshot.take();
      await commitTx(losingTx)
      await commitTx(winingTx)
      await expectRevert(commitTx(losingTx), 'better tx committed');
      await snapshot.revert(ss);
    })

    it("commitTx", async() => {
      const commitTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
        'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a',
        'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
        '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
      ]
      for (const txHash of commitTxs) {
        let [block, proofs, extra, vin, vout] = prepareCommitTx(txHash);
        const blockHash = block.getId();

        await expectRevert(
          instPoR.commitTx('0x'+blockHash.reverseHex(), '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout),
          'no such block',
          );

        await expectRevert(
          instPoR.commitTx('0x'+blockHash, '0x'+proofs.slice(64), '0x'+extra, '0x'+vin, '0x'+vout),
          'invalid merkle proof',
        );

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60-30) // give the chain 30s tolerance
          await instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout);
          await snapshot.revert(ss);
        }

        { // snapshot scope
          const ss = await snapshot.take();
          await time.increaseTo(block.timestamp + 60*60)
          await expectRevert(
            instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout),
            'mining time over',
          );
          await snapshot.revert(ss);
        }

        const extra1 = extra.slice(0, 32) +
          (1).toString(16).pad(8) +  // change the miner input index
          extra.slice(40);

        if (tx.ins.length > 1) {
          await instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+extra1, '0x'+vin, '0x'+vout);
        } else {
          await expectRevert(
            instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+extra1, '0x'+vin, '0x'+vout),
            'Vin read overrun',
          );
        }

        await instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout);
      }
    })

    it("miner", async() => {
      await instPoR.registerMiner('0x'+sender.public, keys[1].address); // register and set the recipient
      await expectRevert(
            instPoR.changeMiner('0x'+sender.pkh, sender.address), "only for old owner");
      await instPoR.registerMiner('0x'+sender.public, ZERO_ADDRESS);    // reset the recipient by PKH
      await instPoR.changeMiner('0x'+sender.pkh, DUMMY_ADDRESS);        // change the recipient by the current owner
      await instPoR.registerMiner('0x'+sender.public, ZERO_ADDRESS);    // reset the recipient by PKH

      await expectRevert(
            instPoR.registerMiner('0x'+keys[1].public, sender.address), "only pkh owner can change the beneficient address");
      await instPoR.registerMiner('0x'+keys[1].public, ZERO_ADDRESS);
      await expectRevert(
            instPoR.changeMiner('0x'+keys[1].pkh, sender.address), "only for old owner");

      // register the rest
      for (let i = 2; i < keys.length; ++i) {
        await instPoR.registerMiner('0x'+keys[i].public, ZERO_ADDRESS);
      }
    })

    it("claimWithPrevTx", async() => {
      const commitTxs = [
        '42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
      ]

      { // scope in
        const txHash = commitTxs[0];
        const txData = txs[txHash];
        await expectRevert(claimWithPrevTx(txData, 0), "mining time not over");
      }

      for (const txHash of commitTxs) {
        const txData = txs[txHash];

        const block = bitcoinjs.Block.fromHex(blocks[txData.block]);

        const MAX_TARGET = 1n<<240n;
        const expectedReward = MAX_TARGET / BigInt('0x'+txData.block);

        const targetTimestamp = block.timestamp + 60*60;
        if (await time.latest() < targetTimestamp) {
          await time.increaseTo(targetTimestamp);
        }

        await expectRevert(claim(txData), "use claimWithPrevTx instead");

        // test the manual PKH position in output script
        { // snapshot scope
          const ss = await snapshot.take();
          // PKH never be in the start of the output script
          await expectRevert(claimWithPrevTx(txData, 0, 10), "unregistered PKH");

          // PKH position in output script is different between segwit and legacy
          const isSegWit = txData.hex.slice(8, 10) === '00';
          await expectEventClaim(claimWithPrevTx(txData, 0, isSegWit ? 11 : 12));
          await snapshot.revert(ss);
        }
        
        if (txData.miner === sender.address) { // we own the miner address
          const ss = await snapshot.take();
          await instPoR.changeMiner('0x'+sender.pkh, DUMMY_ADDRESS);  // change the recipient by the current owner
          await expectEventClaim(claimWithPrevTx(txData, 0), DUMMY_ADDRESS);
          await snapshot.revert(ss);
        }

        // auto detect PKH position
        await expectEventClaim(claimWithPrevTx(txData, 0));
        await expectRevert(claimWithPrevTx(txData, 0), "no such block");

        async function expectEventClaim(call, recipient) {
          const receipt = await call;
          expect(receipt.logs.length).to.equal(2, "claim must emit 2 events");
          expectEvent(receipt, 'Transfer', {
            from: ZERO_ADDRESS,
            to: inst.address,
            value: expectedReward.toString(),
          });
          expectEvent(receipt, 'Reward', {
            memoHash: '0x'+ENDURIO_HASH,
            memo: '0x'+ENDURIO_HEX,
            payer: inst.address,
            payee: recipient || txData.miner,
            amount: expectedReward.toString(),
          });
        }
      }
    })

    it("claim", async() => {
      const commitTxs = [
        'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
        '18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
        'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
        '9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
      ]

      for (const txHash of commitTxs) {
        const txData = txs[txHash];

        const block = bitcoinjs.Block.fromHex(blocks[txData.block]);

        const MAX_TARGET = 1n<<240n;
        const expectedReward = MAX_TARGET / BigInt('0x'+txData.block);

        const targetTimestamp = block.timestamp + 60*60;
        if (await time.latest() < targetTimestamp) {
          await time.increaseTo(targetTimestamp);
        }

        await expectRevert(claimWithPrevTx(txData, 0), "use claim instead");

        if (txData.miner === sender.address) { // we own the miner address
          const ss = await snapshot.take();
          await instPoR.changeMiner('0x'+sender.pkh, DUMMY_ADDRESS);  // change the recipient by the current owner
          await expectEventClaim(claim(txData), DUMMY_ADDRESS);
          await snapshot.revert(ss);
        }

        // auto detect PKH position
        await expectEventClaim(claim(txData));
        await expectRevert(claim(txData), "no such block");

        async function expectEventClaim(call, recipient) {
          const receipt = await call;
          expect(receipt.logs.length).to.equal(2, "claim must emit 2 events");
          expectEvent(receipt, 'Transfer', {
            from: ZERO_ADDRESS,
            to: inst.address,
            value: expectedReward.toString(),
          });
          expectEvent(receipt, 'Reward', {
            memoHash: '0x'+ENDURIO_HASH,
            memo: '0x'+ENDURIO_HEX,
            payer: inst.address,
            payee: recipient || txData.miner,
            amount: expectedReward.toString(),
          });
        }
      }
    })

  })
})

function claim(txData) {
  const tx = bitcoinjs.Transaction.fromHex(txData.hex);
  return instPoR.claim('0x'+txData.block, '0x'+ENDURIO_HASH);
}

function claimWithPrevTx(txData, inputIdx, pkhPos) {
  const tx = bitcoinjs.Transaction.fromHex(txData.hex);
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

  return instPoR.claimWithPrevTx('0x'+txData.block, '0x'+ENDURIO_HASH, '0x'+vin, '0x'+vout, '0x'+extra);
}

function commitTx(txHash) {
  const [block, proofs, extra, vin, vout] = prepareCommitTx(txHash);
  const blockHash = block.getId();
  return instPoR.commitTx('0x'+blockHash, '0x'+proofs, '0x'+extra, '0x'+vin, '0x'+vout);
}

function prepareCommitTx(txHash) {
  const txData = txs[txHash];
  const block = bitcoinjs.Block.fromHex(blocks[txData.block]);
  const [proofs, idx] = getMerkleProof(block, txHash);

  const tx = bitcoinjs.Transaction.fromHex(txData.hex);
  expect(tx.getId()).to.equal(txHash, 'tx data and hash mismatch');
  const [version, vin, vout, locktime] = extractTxParams(txData.hex, tx);

  const outIdx = findMemoOutputIndex(tx.outs, ENDURIO);
  expect(outIdx, 'mining OP_RET output not found').to.not.be.undefined;

  let extra =
    idx.toString(16).pad(8) +
    '00000000' +
    '00000000' +
    '00000000' +
    (0).toString(16).pad(8) +
    outIdx.toString(16).pad(8) +
    locktime.toString(16).pad(8).reverseHex() +
    version.toString(16).pad(8).reverseHex();

  return [block, proofs, extra, vin, vout];
}

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
