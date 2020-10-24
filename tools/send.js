const { btcUtils } = require('./lib/btcUtils');

const accUTA = 'mvxJQTPXkF2ERXKnK5ovnrq7XZFuKmQCKY'

async function doIt() {
    const unspentTxs = await btcUtils.getUnspentTxs('BTC-TEST', accUTA)
    console.log(unspentTxs)
}

doIt()
