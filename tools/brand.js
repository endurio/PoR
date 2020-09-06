const ProxyData = require('./../build/contracts/Proxy.json')
const BrandMarketData = require('./../build/contracts/BrandMarket.json')
const Web3 = require('web3');
// const Tx = require('ethereumjs-tx')
// const BigNumber = require('bignumber.js')
// const crypto = require('crypto');
// const { consoleTestResultHandler } = require('tslint/lib/test');

let args = process.argv
let network = args[2]
switch (network) {
  case 'local':
    var endPoint = 'http://localhost:8545'
    networkId = 111111
    break;
  case 'prod':
    var endPoint = 'https://rpc.nexty.io'
    networkId = 66666
    break;
  case 'dev':
  default:
    var endPoint = 'http://rpc.testnet.nexty.io:8545'
    networkId = 111111
}

const web3 = new Web3(new Web3.providers.HttpProvider(endPoint))
const Proxy = new web3.eth.Contract(ProxyData.abi, ProxyData.networks[networkId].address)
const BrandMarket = new web3.eth.Contract(BrandMarketData.abi, ProxyData.networks[networkId].address)

var myAddress = '0x95e2fcBa1EB33dc4b8c6DCBfCC6352f0a253285d';
var privateKey = Buffer.from('a0cf475a29e527dcb1c35f66f1d78852b14d5f5109f75fa4b38fbe46db2022a5', 'hex')

console.error(Proxy.methods)
