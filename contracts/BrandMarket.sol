// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./Token.sol";
import "./lib/time.sol";
import "./DataStructure.sol";
import "./interface/Initializable.sol";

/**
 * Market for brands to bid for miner.
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract BrandMarket is DataStructure, Token, Initializable {

    function initialize() external override {
        Brand storage brand = brands[ENDURIO_MEMO_HASH][address(0x0)];
        require(brand.payRate == 0, "already initialized");
        brand.payRate = ENDURIO_PAYRATE;
    }

    /**
     * fund and active or power-up a brand campaign
     */
    function activate(
        bytes   calldata memo,
        uint    fund,           // ENDR to deposit
        uint    payRate,
        uint    duration        // (optional) default duration of 2 weeks
    ) external {
        bytes32 memoHash = keccak256(memo);
        Brand storage brand = brands[memoHash][msg.sender];
        if (time.reach(brand.expiration)) {
            // new campaign
            require(payRate > 0, "!payRate");
            require(fund > 0, "!fund");
            brand.payRate = uint192(payRate); // overflowable: unexploitable
            brand.expiration = uint64(time.next(duration > 0 ? duration : 2 weeks)); // overflowable: unexploitable
        } else {
            // power-up old campaign
            if (payRate > 0) {
                require(payRate > brand.payRate, "!expired: increasing pay rate only");
                brand.payRate = uint192(payRate);
            }
            if (duration > 0) {
                uint64 newExpiration = uint64(time.next(duration)); // overflowable: unexploitable
                require(newExpiration > brand.expiration, "!expired: extending expiration only");
                brand.expiration = newExpiration;
            }
        }
        if (fund > 0) {
            _transfer(msg.sender, address(this), fund);
            brand.balance += fund; // overflowable: unexploitable
        }
        emit Active(memoHash, msg.sender, memo, payRate, brand.balance, brand.expiration);
    }

    /**
     * deactivate the campaign and withdraw any remaining fund
     */
    function deactivate(bytes32 memoHash) external {
        Brand storage brand = brands[memoHash][msg.sender];
        require(time.reach(brand.expiration), "!expired");
        _transfer(address(this), msg.sender, brand.balance);
        delete brands[memoHash][msg.sender];
        emit Deactive(memoHash, msg.sender);
    }

    function getCampaignDetails(
        bytes32 memoHash,
        address payer
    ) external view returns (
        uint balance,
        uint payRate,
        uint expiration
    ) {
        Brand storage brand = brands[memoHash][payer];
        return (brand.balance, brand.payRate, brand.expiration);
    }
}
