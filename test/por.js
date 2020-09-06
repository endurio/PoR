const moment = require('moment');
const bitcoinjs = require('bitcoinjs-lib');
const { time } = require('@openzeppelin/test-helpers');
const { blocks } = require('./data/por');

contract("PoR", accounts => {
  before('should chain time be in the past', async () => {
    const chainTime = moment.unix(await time.latest())
    let oldestTimestamp // find the oldest block from the data
    for (const raw of Object.values(blocks)) {
      const block = bitcoinjs.Block.fromHex(raw)
      if (!oldestTimestamp || block.timestamp < oldestTimestamp) {
        oldestTimestamp = block.timestamp
      }
    }
    const oldest = moment.unix(oldestTimestamp)
    assert(chainTime.isBefore(oldest),
      `chain time (${chainTime.fromNow()}) < block.timestamp (${oldest.fromNow()})) - ` +
      `relauch ganache with --time ${oldest.subtract(1, 'hour').toISOString()}`)
  });

  describe('merkle', () => {
    it("merkle", async () => {
      // test something
    })
  })
})
