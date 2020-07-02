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
  '045e6bcc00bd9aaf9eaf0fd3c6365ad45fd9cd7d2e85d805eeb43fb8d59faa80': '020000000001022dc48856f83b6055b1d03a6d4bf9e0242c078ed6a32daa5210d53ae3a8a032b80100000000ffffffffb25edab4745ad697008fbbd64aee5bc3bfa553598030ea1a781a019c761681960000000000ffffffff02c489290000000000160014f089739e70a22a30539ad6ea20b69d722cbe3e8932c90000000000001976a914fc79fd279e3ab8713fe61d686ac350db9c2cd37388ac0247304402202ebc0304ded6a303b2ed0287699ca17f10c463812cfe2cf98590b1ba4f1c38aa02204f4fc4d30d7c92b48770d998cd1dc183a4f73a542bce0e14ac6954da36ada18a012103e62a0640e80570e4e0a2994286e92304ce62388e6872fd1fc9196b8817ed614302483045022100deade3a60725d5c9eb019e07566a06d88345345e3f9d8796d7d3f92b19536a3b022024bd93f63cb39710b8bcd721793e49c0082875f811458b11c1dcadc5917f42f6012103e62a0640e80570e4e0a2994286e92304ce62388e6872fd1fc9196b8817ed614300000000',
  'b832a0a8e33ad51052aa2da3d68e072c24e0f94b6d3ad0b155603bf85688c42d': '02000000000101ccb92e4e9191b0dff87626f0feb3039ce2777b50340fc1f84b87ac3202990cfc0000000000ffffffff028cc00000000000001976a9144ea21afd97e3ce479b16e80c02834f305d23da5288ac65bf290000000000160014f089739e70a22a30539ad6ea20b69d722cbe3e89024730440220143ee93e0256dae8956c30399b1c1a1a834353175604bfdb215f63a6da832b0402206482d68ca9c9d1632e18ab50f6c55a9c27cf725ef1d814149d6e598170923625012103e62a0640e80570e4e0a2994286e92304ce62388e6872fd1fc9196b8817ed614300000000',
  '968116769c011a781aea30805953a5bfc35bee4ad6bb8f0097d65a74b4da5eb2': '0200000000010395e0cfd10458c2064fdbf2b1c8fce7429822ca8ef62b680816e0f318bda236990100000000ffffffffa6214c280b775c35e4b8b2cf68af22c71aef9e963e5fea8785ed26e5be6f36630000000000ffffffff00ef3e146bb863ed6c6da2e01dfd409f93b99d0794a5692eac517ac2c41602730100000000ffffffff023bc9000000000000160014f089739e70a22a30539ad6ea20b69d722cbe3e8982f80300000000001976a91418d5a0b66dda5035a021d561a397973973bde38f88ac024830450221008d697ed655579626873b384f1af425e7b69fb9fc20c647c53bf4008f2e0bbec5022065ec527f78d29b7a73421fd35cd68f5c6ac125f455e969a35fc972f9e4ddf519012103e62a0640e80570e4e0a2994286e92304ce62388e6872fd1fc9196b8817ed614302473044022053c2e004cbda3c68739a7299baaa909327afbfc5791152d814b9c236f14d2e28022033b6917d6f9cc60faefa26ddab38d92e86ee2597731311dc790627c5797eff7e012103e62a0640e80570e4e0a2994286e92304ce62388e6872fd1fc9196b8817ed61430247304402206501592c5513f4947c50b10a869d89b8f57fc444ead52cc6f0d365fee4ca3c1d02203451744117453d72c2587a72cca0bdaf124bdb6b0a3e88c3782132ad7979abd6012103e62a0640e80570e4e0a2994286e92304ce62388e6872fd1fc9196b8817ed614300000000',
  // BTC: P2WSH
  '5841ff53611ce55facbc57d18c0563576af9e5453f2dd1406f4324a0cee02a18': '0100000000010106325bac2f2e7ca67fa46c8304fb3b747e5578df1eef0394349ce2cdd744f7f10100000000ffffffff02db355202000000001976a91489ea1263056ac068adba4844efb376a3a19635ad88ac43b72f0700000000220020701a8d401c84fb13e6baf169d59684e17abd9fa216c8cc5b9fc63d622ff8c58d0400483045022100b4c3ac1d0d785a75d7e0e21b1054f426deac0604635bef79010cc8c961bddec1022043ceac1de07f7011b1c922afc46c19a4aff1d6c5ec24c035330472f6de973f7c0147304402201ed600cde0e2ef4b48b4be8144b26cf91ca62a778c89a27cb8340d99551fbe8b02207fdc4eedb12aeba6fc1eea500000e39dda02487c01837eb78fad5c5e6de2d88e016952210375e00eb72e29da82b89367947f29ef34afb75e8654f6ea368e0acdfd92976b7c2103a1b26313f430c4b15bb1fdce663207659d8cac749a0e53d70eff01874496feff2103c96d495bfdd5ba4145e3e046fee45e84a8a48ad05bd8dbb395c011a32cf9f88053ae00000000'
}

const test_txs = [
  '82616192e0de11fc1a7143becbc02739686fd9b4ab58b15505cd81432dfc8b4a',
  '045e6bcc00bd9aaf9eaf0fd3c6365ad45fd9cd7d2e85d805eeb43fb8d59faa80',
  // '5841ff53611ce55facbc57d18c0563576af9e5453f2dd1406f4324a0cee02a18', // unsupported P2WSH
]

function extractWitness(input) {
  if (input.witness.length > 0) {
    var chunks = input.witness
    var itemName = 'script chunk'
  } else {
    var chunks = bitcoin.script.decompile(input.script)
    var itemName = 'witness'
  }
  const ret = {}
  for (const chunk of chunks) {
    if (Buffer.isBuffer(chunk) && bitcoin.script.isCanonicalScriptSignature(chunk)) {
      ret.sig = bitcoin.script.signature.decode(chunk)
    } else if (Buffer.isBuffer(chunk) && bitcoin.script.isCanonicalPubKey(chunk)) {
      ret.pubKey = chunk
    } else {
      console.log(`ignore unknown ${itemName}`, web3.utils.bytesToHex(chunk))
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
    const { sig, pubKey } = extractWitness(input)
    if (!sig || !pubKey) {
      console.error('unable to extract signature and pubkey from input')
      continue
    }
    // console.log(`\t\tsig`, sig)
    console.log(`\t\tpubkey`, web3.utils.bytesToHex(pubKey))
    if (!sig) {
      console.log('no signature')
      continue
    }
    console.log(`\t\thashType`, sig.hashType)
    console.log(`\t\tsigR`, web3.utils.bytesToHex(sig.signature.subarray(0, 32)))
    console.log(`\t\tsigS`, web3.utils.bytesToHex(sig.signature.subarray(32)))
    const keyPair = bitcoin.ECPair.fromPublicKey(pubKey);
    // const keyPair = bitcoin.ECPair.fromPrivateKey(new Buffer('b8c594fe66aea07ed3f3b8ca10e3e686b2cdcaa7f49a1e0f20d386ef13ba634d', 'hex'))
    console.log(`\t\tpubkey`, web3.utils.bytesToHex(keyPair.publicKey))
    // console.log(input.index, web3.utils.bytesToHex(script), sig.hashType)

    // input tx hash is recorded reversed in the tx binary
    const inputTxHash = Buffer.alloc(input.hash.length, input.hash, 'hex').reverse().toString('hex')
    const inputTxHex = txs[inputTxHash]
    if (!inputTxHex) {
      console.error('prev output tx unavailable', inputTxHash)
      continue
    }
    const inputTx = bitcoin.Transaction.fromHex(inputTxHex)
    const prevOutput = inputTx.outs[input.index]
    if (script.length > 0) {
      console.log(`\t\t\tprev output script`, web3.utils.bytesToHex(prevOutput.script))
      var hash = tx.hashForSignature(i, prevOutput.script, sig.hashType)
    } else {
      const signingScript = bitcoin.payments.p2pkh({ hash: prevOutput.script.slice(2) }).output;
      console.log(`\t\t\tprev witness script`, web3.utils.bytesToHex(signingScript))
      var hash = tx.hashForWitnessV0(i, signingScript, prevOutput.value, sig.hashType)
    }
    console.log(`\t\thash for signature`, web3.utils.bytesToHex(hash))
    const valid = keyPair.verify(hash, sig.signature)
    if (!valid) {
      console.error('================ SIGNATURE INVALID ================')
    } else {
      console.log(`\t\tsignature is valid`)
    }

    // const s = keyPair.sign(hash)
    // console.log('signature', web3.utils.bytesToHex(s), keyPair.verify(hash, s))

    console.log(`\n`)
  }
}
