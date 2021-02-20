const optionalRequire = require("optional-require")(require)
const PrivateKeyProvider = optionalRequire('truffle-privatekey-provider') || {}
const { DeployerPrivateKey, InfuraAPIKey } = optionalRequire('./secret') || {}

module.exports = {
    networks: {
        local: {
            host: "127.0.0.1",
            port: 8545,
            network_id: "*",
        },
        ropsten: {
            provider: () => new PrivateKeyProvider(DeployerPrivateKey, `https://ropsten.infura.io/v3/${InfuraAPIKey}`),
            network_id: 3,       // Ropsten's id
            gasPrice: 1000000000,// 1 gwei
            gas: 8000000,        // Ropsten has a lower block limit than mainnet
            confirmations: 0,    // # of confs to wait between deployments. (default: 0)
            timeoutBlocks: 200,  // # of blocks before a deployment times out  (minimum/default: 50)
            skipDryRun: false,   // Skip dry run before migrations? (default: false for public nets )
        },
        rinkeby: {
            provider: () => new PrivateKeyProvider(DeployerPrivateKey, `https://rinkeby.infura.io/v3/${InfuraAPIKey}`),
            network_id: 4,       // Ropsten's id
            gas: 4500000,        // Ropsten has a lower block limit than mainnet
            confirmations: 0,    // # of confs to wait between deployments. (default: 0)
            timeoutBlocks: 200,  // # of blocks before a deployment times out  (minimum/default: 50)
            skipDryRun: false    // Skip dry run before migrations? (default: false for public nets )
        },
    },
    mocha: {
        reporter: 'eth-gas-reporter',
        reporterOptions: {
            currency: 'USD',
            showTimeSpent: true,
            onlyCalledMethods: true,
            excludeContracts: ["Migrations"],
        },
    },
    compilers: {
        solc: {
            version: '0.6.2',
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 6000000,
                },
            },
        },
    },
}
