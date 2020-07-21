var PoR = artifacts.require("./PoR.sol");
var RefNetwork = artifacts.require("./RefNetwork.sol");

module.exports = async function(deployer) {
    await deployer.deploy(PoR).then(async function() {
        await deployer.deploy(RefNetwork).then(async function() {
            const por = await PoR.deployed()
            console.error(PoR.address)
            const refNet = await RefNetwork.deployed()
            console.error(RefNetwork.address)
            por.initialize(RefNetwork.address)
            refNet.initialize(PoR.address)
        })
    })
};