var PoR = artifacts.require('./PoR.sol');

module.exports = async function(deployer) {
    deployer.deploy(PoR).then(async function() {
    });
};