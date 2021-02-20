var Migrations = artifacts.require("./Migrations.sol");

module.exports = function(deployer) {
  if (deployer.network === 'local') {
    deployer.deploy(Migrations);
  }
};
