const bitcoin = require('bitcoinjs-lib')
// const ecurve = require('ecurve')
const PoR = require('../build/contracts/PoR.json')
const Web3 = require('web3')
const web3 = new Web3()

// const ecparams = ecurve.getCurveByName('secp256k1')

const txs = {
  // BTC-Test: P2PKH
  '82616192e0de11fc1a7143becbc02739686fd9b4ab58b15505cd81432dfc8b4a': '02000000025edbcd2a4ae28241c000ef33d556728a69d3f9bad4e123e5b49ac3800e56bbd8000000006b48304502210093ff4645eaa0ca0c45115cebcf5172ca8151fbef87188ba781e85ac9694ccb720220752c4bcd8b22fbc0e2ce7f3e50265df70db62c3d1f868ee1fefafd424138f4280121028a18217dd2badc2a6ea76c3e49b780bcb2b0231b69e13ef0970754d4b30b7e55ffffffff5edbcd2a4ae28241c000ef33d556728a69d3f9bad4e123e5b49ac3800e56bbd8010000006b483045022100f5964311137f65abe8a8091b32acb034717b45779bd71697a8373c25097c4fe10220032ea7a3edd5504d83cd9711eb8bccb0b436101c38badc1e33e924e0298b86780121028a18217dd2badc2a6ea76c3e49b780bcb2b0231b69e13ef0970754d4b30b7e55ffffffff030090d003000000001976a914e5f04c3aa21d728975dcadc1ca9a251b9642e86688ac19440800000000001976a914e5f04c3aa21d728975dcadc1ca9a251b9642e86688ac0000000000000000176a154330364637634638202d2d2d20656e6475722e696f00000000',
  'd8bb560e80c39ab4e523e1d4baf9d3698a7256d533ef00c04182e24a2acddb5e': '02000000033df77d48c51f40be92c25ca06ed3da53739412d9170b4067e5a4703700ef00a9010000006b483045022100bc3bdb4ada216b68d1d38b7c98dc29319bee9d00ff144b563c775ff124c2a33602201a916fb0425f08152f3c378fd80c3e608696cdf20ac5e4778ddb24b8d67412da0121028a18217dd2badc2a6ea76c3e49b780bcb2b0231b69e13ef0970754d4b30b7e55ffffffff37d58f85bc181694f6602cbc8ce54908793419ea7156316dc4cdace65d231b70000000006a473044022028ee08e836f6d624b9f9cd5d7113e3877749c3a01d7d9badeeec25cc1ec74d13022041c87eb533ec4be1d80364f40eba9edbe97a9390b62aed26a3d97af3c0715fa40121028a18217dd2badc2a6ea76c3e49b780bcb2b0231b69e13ef0970754d4b30b7e55ffffffff37d58f85bc181694f6602cbc8ce54908793419ea7156316dc4cdace65d231b70010000006b48304502210084f1b38b61bba72b0549f7d7a241f79461222d2385c6ef0924487c814c2ad4f802207e878750e947f56475520b79e0ea714803fd27ab90677a8667fdf6fd3b5494940121028a18217dd2badc2a6ea76c3e49b780bcb2b0231b69e13ef0970754d4b30b7e55ffffffff030090d003000000001976a914e5f04c3aa21d728975dcadc1ca9a251b9642e86688ac197b0800000000001976a914e5f04c3aa21d728975dcadc1ca9a251b9642e86688ac0000000000000000196a177177657274797a786376626e6d3a20656e6475722e696f00000000',
  // BTC: P2WPKH
  '5841ff53611ce55facbc57d18c0563576af9e5453f2dd1406f4324a0cee02a18': '0100000000010106325bac2f2e7ca67fa46c8304fb3b747e5578df1eef0394349ce2cdd744f7f10100000000ffffffff02db355202000000001976a91489ea1263056ac068adba4844efb376a3a19635ad88ac43b72f0700000000220020701a8d401c84fb13e6baf169d59684e17abd9fa216c8cc5b9fc63d622ff8c58d0400483045022100b4c3ac1d0d785a75d7e0e21b1054f426deac0604635bef79010cc8c961bddec1022043ceac1de07f7011b1c922afc46c19a4aff1d6c5ec24c035330472f6de973f7c0147304402201ed600cde0e2ef4b48b4be8144b26cf91ca62a778c89a27cb8340d99551fbe8b02207fdc4eedb12aeba6fc1eea500000e39dda02487c01837eb78fad5c5e6de2d88e016952210375e00eb72e29da82b89367947f29ef34afb75e8654f6ea368e0acdfd92976b7c2103a1b26313f430c4b15bb1fdce663207659d8cac749a0e53d70eff01874496feff2103c96d495bfdd5ba4145e3e046fee45e84a8a48ad05bd8dbb395c011a32cf9f88053ae00000000',
  'f1f744d7cde29c349403ef1edf78557e743bfb04836ca47fa67c2e2fac5b3206': '01000000000101ea0709df63c776721d9a93cc19a96756f611d5ba0df35229ec757e993f4f17590500000000ffffffff02d2f77100000000001976a9146e40826fdf7510a386dee3360f6e14fc6da5cc3b88acae4c830900000000220020701a8d401c84fb13e6baf169d59684e17abd9fa216c8cc5b9fc63d622ff8c58d04004730440220292391068f0c81d97a1d198415a279814e3b06191726e79fc176adc0ba81c35f02202be76f8b9f7fd216335cfaf6ce4f463121a871cca27305de50d9e7ade2d57e5401473044022015219d2f2697e740aac606d9f259717b209d0d1ae6eb01c29465d4d64f552a8a02200e6df7ae00e4fa7da91648ef3be8863d5e304ae483753b4df88d7bff427ec9fa016952210375e00eb72e29da82b89367947f29ef34afb75e8654f6ea368e0acdfd92976b7c2103a1b26313f430c4b15bb1fdce663207659d8cac749a0e53d70eff01874496feff2103c96d495bfdd5ba4145e3e046fee45e84a8a48ad05bd8dbb395c011a32cf9f88053ae00000000',
}

const test_txs = [
  '82616192e0de11fc1a7143becbc02739686fd9b4ab58b15505cd81432dfc8b4a',
  '5841ff53611ce55facbc57d18c0563576af9e5453f2dd1406f4324a0cee02a18',
]

function parse(script) {
  const ret = {}
  const chunks = bitcoin.script.decompile(script)
  for (const chunk of chunks) {
    if (Buffer.isBuffer(chunk) && bitcoin.script.isCanonicalScriptSignature(chunk)) {
      ret.sig = bitcoin.script.signature.decode(chunk)
    } else if (Buffer.isBuffer(chunk) && bitcoin.script.isCanonicalPubKey(chunk)) {
      ret.pubKey = chunk
    } else {
      console.log('unknow script item', chunk)
    }
  }
  return ret
}

for (const txHash of test_txs) {
  const tx = bitcoin.Transaction.fromHex(txs[txHash])
  // console.log(`\ntx`, tx.toHex())
  for (let i = 0; i < tx.ins.length; ++i) {
    const input = tx.ins[i]
    // console.log(`\tinput`, input)
    const script = input.script
    console.log(`\tscript`, web3.utils.bytesToHex(script))
    const { sig, pubKey } = parse(script)
    // console.log(`\t\t\tsig`, sig)
    console.log(`\t\t\tpubkey`, web3.utils.bytesToHex(pubKey))
    if (!sig) {
      console.log('no signature')
      continue
    }
    console.log(`\t\t\thashType`, sig.hashType)
    console.log(`\t\t\tsigR`, web3.utils.bytesToHex(sig.signature.subarray(0, 32)))
    console.log(`\t\t\tsigS`, web3.utils.bytesToHex(sig.signature.subarray(32)))
    const keyPair = bitcoin.ECPair.fromPublicKey(pubKey);
    // const keyPair = bitcoin.ECPair.fromPrivateKey(new Buffer('b8c594fe66aea07ed3f3b8ca10e3e686b2cdcaa7f49a1e0f20d386ef13ba634d', 'hex'))
    console.log(`\t\t\tpubkey`, web3.utils.bytesToHex(keyPair.publicKey))
    // console.log(input.index, web3.utils.bytesToHex(script), sig.hashType)

    // input tx hash is recorded reversed in the tx binary
    const inputTxHash = new Buffer(input.hash, 'hex').reverse().toString('hex')
    const inputTxHex = txs[inputTxHash]
    if (!inputTxHex) {
      console.error('prev output tx unavailable', inputTxHash)
      continue
    }
    const inputTx = bitcoin.Transaction.fromHex(inputTxHex)
    const prevOutput = inputTx.outs[input.index]
    console.log(`\t\t\t\tprev output script`, web3.utils.bytesToHex(prevOutput.script))
    const hash = tx.hashForSignature(i, prevOutput.script, sig.hashType)
    console.log(`\t\t\thash for signature`, web3.utils.bytesToHex(hash))
    const valid = keyPair.verify(hash, sig.signature)
    console.log(`\t\t\tvalid`, valid)

    // const s = keyPair.sign(hash)
    // console.log('signature', web3.utils.bytesToHex(s), keyPair.verify(hash, s))

    console.log(`\n`)
  }
}
