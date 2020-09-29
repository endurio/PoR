module.exports = {
    networks: {
        local: {
            host: "127.0.0.1",
            port: 8545,
            network_id: "*",
        },
    },
    mocha: {
        reporter: 'eth-gas-reporter',
        reporterOptions: {
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
