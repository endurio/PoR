const _ = require('lodash');
const { btcUtils } = require('./lib/btcUtils');
const { decShift } = require('./lib/big');
const Btc = require('bitcoinjs-lib');
const prompt = require('prompt');

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

const ECPairs = {
    [accUTALegacy]: Btc.ECPair.fromPrivateKey(Buffer.from('443F917B8486E3F61320660B0F5F425A4A2C36FD658ECC325B755721C040D606', 'hex')),
}

const memo = 'foobar'
const symbol = 'BTC-TEST'
const MaxOutput = 8
const RecipientRate = 32

const FEE_RATE = {
    'BTC': 150,
    'BTC-TEST': 0.672,  // or 20?
}

const BOUNTY = {
    'BTC-TEST': 613,
}

const FEE = {
    'BTC-TEST': 999,
}

async function doIt() {
    const sender = accUTALegacy
    console.log('get UTXO', sender)
    const utxos = await btcUtils.getUnspentTxs(symbol, sender)
    console.log('search for best input')
    const input = await searchForInput(utxos)
    console.log('found best input')
    if (!input.recipients || input.recipients.length === 0) {
        throw 'no eligible recipient'
    }

    console.log('sort the best input into the start of the input list')
    // move the found input to the first of the array
    const recipients = input.recipients
    const inputs = [input]
    utxos.forEach(o => {
        delete o.recipients
        if (o.txid !== input.txid || o.vout !== input.vout) {
            inputs.push(o)
        }
    })

    console.log('create the PSBT object')
    const network = btcUtils.getNetwork(symbol)
    const psbt = new Btc.Psbt({network});

    console.log('add the memo output')
    const data = Buffer.from(memo, 'utf8')
    const dataScript = Btc.payments.embed({data:[data]})
    psbt.addOutput({
        script: dataScript.output,
        value: 0,
    })

    console.log('build the mining outputs and required inputs')
    await build(psbt, inputs, recipients, sender)

    const tx = psbt.extractTransaction()

    console.error('tx:', tx)
    console.error('byte length', tx.byteLength(true), tx.byteLength(false))
    console.error('size', tx.virtualSize(), tx.weight(), tx.toBuffer().length)

    console.error('fee', psbt.getFee())
    console.error('feeRate', psbt.getFeeRate(), psbt.getFee() / tx.toBuffer().length)

    prompt.start();
    prompt.get('send', (err, result) => {
        if (err) throw err
        if (['y','Y'].includes(result.send)) {
            btcUtils.sendRawTx(symbol, tx.toHex()).then(txHash => console.error('Tx Sent', txHash))
        }
    });
}

async function build(psbt, inputs, recipients, sender) {
    let inValue = 0
    let outValue = 0

    async function buildWithoutChange(psbt) {
        let recIdx = 0
        for (const input of inputs) {
            const tx_hex = await btcUtils.getTxHexFromTxHash(input.txid, symbol)
            psbt.addInput({
                hash: input.txid,
                index: input.vout,
                // non-segwit inputs now require passing the whole previous tx as Buffer
                nonWitnessUtxo: Buffer.from(tx_hex, 'hex'),
            })
            // psbt.signInput(psbt.txInputs.length-1, ECPairs[sender])
            inValue += parseInt(decShift(input.amount, 8))

            for (let i = recIdx; i < recipients.length; ++i) {
                const rec = recipients[i]
                const output = rec.txouts[rec.txouts.length-1]
                const amount = BOUNTY[symbol] // TODO: calculate this
                if (outValue + amount > inValue) {
                    break;  // need more input
                }
                outValue += amount
                psbt.addOutput({
                    script: Buffer.from(output.script.hex, 'hex'),
                    value: amount,
                })
                if (psbt.txOutputs.length > MaxOutput) {
                    console.log('recipients list exhausted')
                    return
                }
            }
        }
        console.log('utxo list exhausted')
    }

    await buildWithoutChange(psbt)

    console.error('size before adding change output', psbt.toBuffer().length)

    // assert(inValue > outValue)
    psbt.addOutput({
        address: sender,
        value: inValue - outValue - FEE[symbol],
    })

    console.error('size after adding change output', psbt.toBuffer().length)

    psbt.signAllInputs(ECPairs[sender])

    console.error('size after sign all inputs', psbt.toBuffer().length)

    psbt.finalizeAllInputs()

    console.error('size after finalize all inputs', psbt.toBuffer().length)

    return psbt
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
                if (!isHit(utxo.txid, recipient)) {
                    continue
                }
                // check for OP_RET in recipient tx
                const tx = await btcUtils.requestCryptoAPI(symbol, `txs/txid/${recipient}`)
                const hasOpRet = tx.txouts.some(o => o.script.hex.startsWith('6a'))   // OP_RET = 0x6a
                if (hasOpRet) {
                    continue
                }
                utxo.recipients.push(tx)
                if (utxo.recipients.length >= MaxOutput) {
                    return utxo
                }
            }
        }
    }
    const utxoWithMostRecipient = utxos.reduce((prev, current) => prev.recipients.length > current.recipients.length ? prev : current)
    return utxoWithMostRecipient
}

function isHit(txid, recipient) {
    const preimage = txid + recipient
    const hash = web3.utils.keccak256(Buffer.from(preimage, 'hex'))
    return parseInt(hash.substring(hash.length-2), 16) % RecipientRate === 0
}

doIt()
