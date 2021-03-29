const { txs } = require('../test/data/all')
const bitcoinjs = require('bitcoinjs-lib')
const Web3 = require('web3')
const web3 = new Web3()

const test_txs = [
	// '82616192e0de11fc1a7143becbc02739686fd9b4ab58b15505cd81432dfc8b4a', // P2PKH
	// '045e6bcc00bd9aaf9eaf0fd3c6365ad45fd9cd7d2e85d805eeb43fb8d59faa80', // P2WPKH
	// '5841ff53611ce55facbc57d18c0563576af9e5453f2dd1406f4324a0cee02a18', // unsupported P2WSH
	'c7016e7816b6f0eeb3dba660266e42c3b7780c657ce5bfd196f216df9ad38d3c',
	'18603113e8d4d78f6de668f8abfd8d38747b030329116aa59df889a27e5a867a',
	//'f37d569b7d940e687e55bad5f56341dd1b82ac0047fa6e6346c06ef0cbecbd8a', // missing miner key?
	'c67326c89d8dc0cfdb10be00983236702fef8246234d7a3ecfa6cb6ac01c9d78',
	'9f3c5b61aec0d0df4a6271f3cde21c2f661489b7be0afbd9b326223646467e7f',
	'9da4809c20689edf1874a47f8b9c60adbcd888400eb46b368cd21cdbe2517e5d',
	'42cd88e6dc4aa56ea823ea4aee6b5276a7164134d9c001ea0547c850e1cae8b1',
	'2251a6f442369cfae9bc3f6f5d09389feb6ca3e8599443a059d84fb3be4da7ac',
]

function extractWitness(input) {
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

function extractSignature(tx, i) {
	const input = tx.ins[i]
	// console.log(`\tinput`, input)
	const { sig, pubkey } = extractWitness(input)
	if (!sig || !pubkey) {
		throw 'unable to extract signature and pubkey from input'
	}
	// console.log(`sig`, sig)
	console.log(`pubkey`, web3.utils.bytesToHex(pubkey))
	if (!sig) {
		throw 'no signature'
	}
	// console.log(`hashType`, sig.hashType)
	// console.log(`sigR\t`, web3.utils.bytesToHex(sig.signature.subarray(0, 32)))
	// console.log(`sigS\t`, web3.utils.bytesToHex(sig.signature.subarray(32)))

	// input tx hash is recorded reversed in the tx binary
	const inputTxHash = Buffer.alloc(input.hash.length, input.hash, 'hex').reverse().toString('hex')
	if (!txs[inputTxHash]) {
		throw 'prev output tx unavailable: ' + inputTxHash
	}
	const dxHex = txs[inputTxHash].hex
	const dx = bitcoinjs.Transaction.fromHex(dxHex)
	const prevOut = dx.outs[input.index]

	// const pkh = bitcoinjs.crypto.hash160(pubkey)
	// console.log(`PKH\t`, web3.utils.bytesToHex(pkh))
	// // console.log(input.index, web3.utils.bytesToHex(script), sig.hashType)

	// if (prevOut.script.indexOf(pkh) < 0) {
	// 	throw `FAILED: prev output script does not contain PKH`
	// } else {
	// 	console.log(`CHECKED`)
	// }
	// console.log(`\tprev output script`, web3.utils.bytesToHex(prevOut.script))
	// console.error('input.script', input.script.toString('hex'))
	// console.error('prevOut.script', prevOut.script.toString('hex'))
	if (prevOut.script[0] == 0x00 && prevOut.script[1] == 0x14) {
		const signingScript = bitcoinjs.payments.p2pkh({ hash: prevOut.script.slice(2) }).output;
		console.log(`\tsigning script`, web3.utils.bytesToHex(signingScript))
		var hash = tx.hashForWitnessV0(i, signingScript, prevOut.value, sig.hashType)

		const address = bitcoinjs.payments.p2wpkh({ pubkey }).address
		console.log(`\tP2WPKH\t`, address)
	// } else if (prevOut.script[0] == 0xa9 && prevOut.script[1] == 0x14) {
	// 	throw 'p2sh not supported'
	// 	// const signingScript = bitcoinjs.payments.p2sh({ redeem: { output: input.script }}).output;
	// 	// var hash = tx.hashForWitnessV0(i, signingScript, prevOut.value, sig.hashType)
	// 	// var hash = tx.hashForSignature(i, input.script, sig.hashType)
	} else {
		var hash = tx.hashForSignature(i, prevOut.script, sig.hashType)
	}
	return { sig, pubkey, hash }
}

for (const txHash of test_txs) {
	console.error(txHash)
	const tx = bitcoinjs.Transaction.fromHex(txs[txHash].hex)
	// console.log(`\ntx`, tx.toHex())
	for (let i = 0; i < tx.ins.length; ++i) {
		try {
			const { sig, pubkey, hash } = extractSignature(tx, i)
			console.log(`hash for signature`, web3.utils.bytesToHex(hash))

			const keyPair = bitcoinjs.ECPair.fromPublicKey(pubkey);
			// const keyPair = bitcoinjs.ECPair.fromPrivateKey(new Buffer('b8c594fe66aea07ed3f3b8ca10e3e686b2cdcaa7f49a1e0f20d386ef13ba634d', 'hex'))
			console.log(`pubkey\t`, web3.utils.bytesToHex(keyPair.publicKey))

			const valid = keyPair.verify(hash, sig.signature)
			if (!valid) {
				console.error('\nSIGNATURE INVALID', tx)
			} else {
				console.error('\nSIGNATURE VALID')
			}

			console.log(`\n`)
		} catch (err) {
			console.error(err)
		}
	}
}
