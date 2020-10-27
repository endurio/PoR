const { btcUtils } = require('./lib/btcUtils');

const accUTALegacy = 'mvxJQTPXkF2ERXKnK5ovnrq7XZFuKmQCKY'
const accUTASegwit = 'tb1q49239d5pwn63cqhmnnfgu8z6ndzah7dycgcfql'
const accUTBSegwit = 'tb1qxu05semvm9z0krgrd2sz5jcunmzldhathrehlp'

const accs = [
    accUTALegacy,
    accUTASegwit,
    accUTBSegwit,
]

const symbol = 'BTC-TEST'
const feeRate = {
    'BTC': 150,
    'BTC-TEST': 0.672,  // or 20?
}

async function doIt() {
    btcUtils.getUnspentTxs(symbol, accUTALegacy).then(console.log)
}

doIt()
