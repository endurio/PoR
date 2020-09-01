// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./lib/util.sol";
import "./lib/suint192.sol";
import "./DataStructure.sol";
import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";

/**
 * Market for brands to bid for miner.
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract BrandMarket is DataStructure {
    using suint192 for SUint192;
    using BytesLib for bytes;

    bytes   constant ENDURIO_MEMO               = "endur.io";
    uint192 constant ENDURIO_PAYRATE            = 1e18;

    constructor() public {
        Brand storage brand = brands[keccak256(ENDURIO_MEMO)];
        brand.payer = address(this);
        brand.payRate.commit(ENDURIO_PAYRATE);
        brand.memo = ENDURIO_MEMO;
    }

    /**
     * Register/take over, deposit and active a brand
     */
    function register(
        bytes   calldata memo,
        uint    amount,         // initial deposit
        uint192 payRate         // zero to disable auto activation
    ) external {
        require(amount >= payRate * ACTIVE_CONDITION_PAYRATE, "not enough deposit for given payrate");
        bytes32 memoHash = keccak256(memo);
        Brand storage brand = brands[memoHash];
        address payer = brand.payer;
        if (payer == address(0x0)) {
            // new brand
            brand.memo = memo;
        } else {
            require(msg.sender != payer, "re-register not allowed");
            // brand can be overtaken when (1) brand is inactive or (2) new pay rate is better
            require(payRate > brand.payRate.max(), "pay rate too low for overtaking");
            _transfer(address(this), payer, brand.balance); // refund the old payer
        }
        _transfer(msg.sender, address(this), amount);
        brand.payer = msg.sender;
        brand.balance = amount;
        _setPayRate(brand, payRate);
        emit Active(memoHash, memo.toBytes32(), payRate, msg.sender, amount);
    }

    /**
     * activate, cancel any on-going deactivation and set the payRate
     */
    function activate(bytes32 memoHash, uint192 payRate) external {
        require(payRate > 0, "zero payrate");
        Brand storage brand = brands[memoHash];
        address payer = brand.payer;
        require(msg.sender == payer, "current payer only");
        uint balance = brand.balance;
        require(balance >= payRate * ACTIVE_CONDITION_PAYRATE, "not enough deposit for given payrate");
        _setPayRate(brand, payRate);
        emit Active(memoHash, brand.memo.toBytes32(), payRate, payer, balance);
    }

    /**
     * request to deactivate the brand
     */
    function deactivate(bytes32 memoHash) external {
        Brand storage brand = brands[memoHash];
        require(msg.sender == brand.payer, "current payer only");
        require(brand.payRate.scheduled() > 0, "already pending for deactivation");
        brand.payRate.schedule(0, PAYRATE_DELAY);
        emit Deactive(memoHash);
    }

    /**
     * Changing the payrate requires a delay of 40 mins.
     */
    function _setPayRate(Brand storage brand, uint192 payRate) internal {
        brand.payRate.schedule(payRate, PAYRATE_DELAY);
    }

    function withdraw(bytes32 memoHash) external {
        Brand storage brand = brands[memoHash];
        address payer = brand.payer;
        require(msg.sender == payer, "current payer only");
        require(brand.payRate.committed() == 0, "brand not deactivated");
        uint balance = brand.balance;
        require(balance > 0, "empty balance");
        _transfer(address(this), payer, balance);
    }

    /**
     * deposit to a brand regardless of its payer
     */
    function deposit(bytes32 memoHash, uint amount) external {
        _deposit(brands[memoHash], amount);
    }

    /**
     * deposit to a brand with given payer
     */
    function deposit(bytes32 memoHash, address payer, uint amount) external {
        Brand storage brand = brands[memoHash];
        require(brand.payer == payer, "payer mismatches");
        _deposit(brand, amount);
    }

    function _deposit(Brand storage brand, uint amount) internal {
        _transfer(msg.sender, address(this), amount);
        brand.balance += amount;
    }
}
