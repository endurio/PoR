const { btcUtils } = require('./lib/btcUtils');

const Web3 = require('web3')
const web3 = new Web3()

const accUTALegacy = 'mvxJQTPXkF2ERXKnK5ovnrq7XZFuKmQCKY'
const accUTASegwit = 'tb1q49239d5pwn63cqhmnnfgu8z6ndzah7dycgcfql'
const accUTBSegwit = 'tb1qxu05semvm9z0krgrd2sz5jcunmzldhathrehlp'

const accs = [
    accUTALegacy,
    accUTASegwit,
    accUTBSegwit,
]

const symbol = 'BTC-TEST'
const MaxOutput = 8
const RecipientRate = 32
const feeRate = {
    'BTC': 150,
    'BTC-TEST': 0.672,  // or 20?
}

async function doIt() {
    const utxos = await btcUtils.getUnspentTxs(symbol, accUTALegacy)
    const input = await searchForInput(utxos)
    console.error(input)
}

async function searchForInput(utxos, maxBlocks = 6) {
    const info = await btcUtils.requestCryptoAPI(symbol, 'info')
    utxos.forEach(utxo => {
        utxo.recipients = []
    })
    for (let n = info.blocks; n > info.blocks-maxBlocks; --n) {
        const block = await btcUtils.requestCryptoAPI(symbol, `blocks/${n}`)
        for (const recipient of block.tx) {
            for (const utxo of utxos) {
                const preimage = utxo.txid + recipient
                const hash = web3.utils.keccak256(Buffer.from(preimage, 'hex'))
                const hit = parseInt(hash.substring(hash.length-2), 16) % RecipientRate === 0
                if (hit) {
                    utxo.recipients.push(recipient)
                    if (utxo.recipients.length >= MaxOutput) {
                        return utxo
                    }
                }
            }
        }
    }
    const utxoWithMostRecipient = utxos.reduce((prev, current) => prev.recipients.length > current.recipients.length ? prev : current)
    return utxoWithMostRecipient
}

doIt()
