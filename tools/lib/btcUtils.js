const CoinKey = require('coinkey');
const ci = require('coininfo');
const BigNumber = require('bignumber.js');
const Btc = require('bitcoinjs-lib');
const rp = require('request-promise');
const coinSelect = require('coinselect');
const WIFKEY = require('wif');
const homedir = require('os').homedir();
const { BlockCypherAPIKey, CryptoAPIsAPIKey } = require(`${homedir}/.config/por/send.config.js`);

const getPartURLCryptoAPI = (symbol) => {
    let part
    switch (symbol) {
        case "BTC":
            part = "btc/mainnet"
            break;
        case "LTC":
            part = "ltc/mainnet"
            break;
        case "BTC-TEST":
            part = "btc/testnet"
            break;
        default:
            part = "btc/mainnet"
            break;
    }
    return part
}
const getPartURLBlockcypher = (symbol) => {
    let part
    switch (symbol) {
        case "BTC":
            part = "btc/main"
            break;
        case "LTC":
            part = "ltc/main"
            break;
        case "BTC-TEST":
            part = "btc/test3"
            break;
        default:
            part = "btc/main"
            break;
    }
    return part
}

const getNetwork = (coinType) => {
    let coinInfo = ci(coinType);
    let network = {
        messagePrefix: coinInfo.messagePrefix ? coinInfo.messagePrefix : '',
        bech32: coinInfo.bech32,
        bip32: coinInfo.versions.bip32,
        pubKeyHash: coinInfo.versions.public,
        scriptHash: coinInfo.versions.scripthash,
        wif: coinInfo.versions.private,
    };
    return network;
};

exports.btcUtils = {
    derivePathPrefix(typeCoinInfo, isSegWit = false) {
        const coinInfo = ci(typeCoinInfo);
        if (isSegWit) return `m/84'/${coinInfo.versions.bip44}'/0'/0`
        return `m/44'/${coinInfo.versions.bip44}'/0'/0`
    },
    getDerivePath(typeCoinInfo, index, isSegWit = false) {
        return `${this.derivePathPrefix(typeCoinInfo, isSegWit)}/${index}` 
    },

    convertWifToHex (WIF){
        return WIFKEY.decode(WIF).privateKey.toString('hex');
    },

    convertHexToWif (privateKey, symbol){
        const coinInfo = ci(symbol);
        const obj = {
            version: coinInfo.versions.private,
            privateKey: Buffer.from(privateKey, 'hex'),
            compressed: true
        }
        return WIFKEY.encode(obj);
    },

    getBtcAccount(typeCoinInfo, privateData, isSegWit = false) {
        try {
            let privateKey, WIF
            if (_.isString(privateData)) {
                privateKey = privateData
                WIF = this.convertHexToWif(privateKey, typeCoinInfo)
            } else {
                privateKey = privateData.privateKey
                WIF = privateData.wif
            }
            if (isSegWit) {
                const network = getNetwork(typeCoinInfo)
                const keyPair = Btc.ECPair.fromWIF(
                    WIF,
                    network
                );
                const { address } = Btc.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
                return address
            }
            const coinInfo = ci(typeCoinInfo);
            const key = new CoinKey(new Buffer(privateKey, 'hex'), { private: coinInfo.versions.private, public: coinInfo.versions.public });
            return key.publicAddress.toString('hex');
        } catch (error) {
            console.error(error);
            return null
        }
    },
    getBtcAddress(typeCoinInfo, privateKey, isSegWit = false) {
        return this.getBtcAccount(typeCoinInfo, privateKey, isSegWit);;
    },

    async getUnspentTxs (symbol, address) {
        let part = getPartURLBlockcypher(symbol);
        let url = `https://api.blockcypher.com/v1/${part}/addrs/${address}?unspentOnly=true`
        if (BlockCypherAPIKey) {
            url = url + `&token=${BlockCypherAPIKey}`
        }
        const requestOptions = {
            method: 'GET',
            uri: url,
            qs: {
            },
            json: true,
        };
    
        let rs = await rp(requestOptions);
        if (!rs) return [];
        let txs = rs.txrefs ? rs.unconfirmed_txrefs ? rs.txrefs.concat(rs.unconfirmed_txrefs) : rs.txrefs : rs.unconfirmed_txrefs ? rs.unconfirmed_txrefs : '' ;
    
        return txs;
    },

    async getTxHexFromTxHash (txHash, symbol) {
        let part = getPartURLCryptoAPI(symbol);
        let url = `https://api.cryptoapis.io/v1/bc/${part}/txs/raw/txid/${txHash}`
        let rs = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": CryptoAPIsAPIKey,
            }
        })
        let data = await rs.json();
        return data.payload.hex;
    },

    async buildRawTx(utxos, WIF, network, targets, feeRate, changeAddress, data, isSegWit, symbol, sequence, skipSigning = false) {
        if (!changeAddress) throw new Error("No change Address provided");
        sequence = sequence || 0xffffffff;
    
        const { inputs, outputs, fee } = coinSelect(utxos, targets, feeRate);
        if (!inputs || !outputs) {
            throw new Error('Not enough balance. Try sending smaller amount');
        }
    
        const psbt = new Btc.Psbt({ network });
        let tx_hex
        let c = 0;
        const values = {};
        let keyPair;
        const lastedTxHash = inputs[inputs.length - 1].tx_hash
    
        if (!isSegWit) {
            tx_hex = await this.getTxHexFromTxHash(lastedTxHash, symbol)
        }
        inputs.forEach(input => {
            if (!skipSigning) {
                keyPair = Btc.ECPair.fromWIF(WIF, network);
            }
            values[c] = input.value;
            c++;
    
            if (isSegWit) {
                const pubkey = keyPair.publicKey;
                const p2wpkh = Btc.payments.p2wpkh({ pubkey, network });
                psbt.addInput({
                    hash: input.tx_hash,
                    index: input.tx_output_n,
                    sequence,
                    witnessUtxo: {
                        script: p2wpkh.output,
                        value: input.value
                    }
                });
            } else {
                if (!tx_hex) throw new Error('UTXO is missing txhex of the input, which is required by PSBT for non-segwit input');
                psbt.addInput({
                    hash: input.tx_hash,
                    index: input.tx_output_n,
                    sequence,
                    // non-segwit inputs now require passing the whole previous tx as Buffer
                    nonWitnessUtxo: Buffer.from(tx_hex, 'hex'),
                });
            }
        });
    
        outputs.forEach(output => {
            if (!output.address) {
                output.address = changeAddress;
            }
    
            const outputData = {
                address: output.address,
                value: output.value,
            }
    
            psbt.addOutput(outputData);
        });
    
        if (data) {
            data = Buffer.from(data, 'utf8')
            const dataScript = Btc.payments.embed({ data: [data]})
            psbt.addOutput({
                script: dataScript.output,
                value: 0
            })
        }
    
        if (!skipSigning) {
            for (let cc = 0; cc < c; cc++) {
                psbt.signInput(cc, keyPair);
            }
        }
    
        let tx;
        if (!skipSigning) {
            tx = psbt.finalizeAllInputs().extractTransaction();
        }
        return { tx, inputs, outputs, fee, psbt }
    },

    async sendRawTx (symbol, txHex) {
        let part = getPartURLCryptoAPI(symbol);
        let url = `https://api.cryptoapis.io/v1/bc/${part}/txs/send/`

        let body = {
            "hex": txHex
        }
        let rs = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CryptoAPIsAPIKey,
            },
            body: JSON.stringify(body)
        });
        let data = await rs.json();
        console.log('Data', data);
        if (data.meta && data.meta.error) {
            throw data.meta.error
        }
        return data.payload.txid;
    },
  
    async transfer(txParams) {
        const { typeCoinInfo, privateKey, to, amount, symbol, gasPrice, isSegWit, data } = txParams
        const address = this.getBtcAccount(typeCoinInfo, privateKey, isSegWit);
        const WIF = privateKey.wif
        const network = getNetwork(typeCoinInfo);

        let toTransfer = new BigNumber(amount);
        toTransfer = parseFloat(toTransfer)

        let txs = await this.getUnspentTxs(symbol, address);
        const targets = [{
            value: toTransfer,
            address: to
        }]
        const { tx } = await this.buildRawTx(txs, WIF, network, targets, gasPrice, address, data, isSegWit, symbol);
        let txHash = await this.sendRawTx(symbol, tx.toHex());
        return {
            hash: txHash,
            from: address,
            txParams,
        };
    },

    btcTokenValidator(token, address) {
        const regs = {
            BTC: /^(?:1|3|bc)/,
            BTC_TEST: /^(?:m|2|tb)/,
            LTC: /^(?:L|M|ltc)/,
        }
        let result
        switch (token.symbol) {
            case 'BTC':
                result = regs.BTC.test(address)
                break;
            case 'BTC-TEST':
                result = regs.BTC_TEST.test(address)
                break;
            case 'LTC':
                result = regs.LTC.test(address)
                break;
            default:
                break;
        }
        return result
    },
    btcAddressValidator(token, address) {
        const regs = {
            legacy: {
                BTC: /^1/,
                BTC_TEST: /^m/,
                LTC: /^L/,
            },
            segwit: {
                BTC: /^(?:3|bc)/,
                BTC_TEST: /^(?:2|tb)/,
                LTC: /^(?:M|ltc)/,
            }
        }
        let result
        if (token.isSegWit) {
            switch (token.symbol) {
                case 'BTC':
                    result = regs.segwit.BTC.test(address)
                    break;
                case 'BTC-TEST':
                    result = regs.segwit.BTC_TEST.test(address)
                    break;
                case 'LTC':
                    result = regs.segwit.LTC.test(address)
                    break;
                default:
                    break;
            }
        } else {
            switch (token.symbol) {
                case 'BTC':
                    result = regs.legacy.BTC.test(address)
                    break;
                case 'BTC-TEST':
                    result = regs.legacy.BTC_TEST.test(address)
                    break;
                case 'LTC':
                    result = regs.legacy.LTC.test(address)
                    break;
                default:
                    break;
            }
        }
        return result
    },
};
