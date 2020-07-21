const Proxy = artifacts.require('./Proxy.sol');
const PoR = artifacts.require('./PoR.sol');
const RefNetwork = artifacts.require('./RefNetwork.sol');
const BrandMarket = artifacts.require('./BrandMarket.sol');

module.exports = async function(deployer) {
    await deployer.deploy(PoR)
    await deployer.deploy(RefNetwork)
    await deployer.deploy(BrandMarket)
    await deployer.deploy(Proxy,
        BrandMarket.address,
        BrandMarket.address,
        RefNetwork.address,
        PoR.address,
    );
};