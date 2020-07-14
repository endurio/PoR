// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./lib/util.sol";
import "./lib/sval.sol";
import {RefNetwork} from "./RefNetwork.sol";
import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";

/**
 * Market for brands to bid for miner.
 */
contract BrandMarket is RefNetwork {
    using sval for SUint;
    using BytesLib for bytes;

    bytes   constant ENDURIO_MEMO = "endur.io";
    uint    constant ENDURIO_PAYRATE = 1e18;
    uint    constant ACTIVE_CONDITION_PAYRATE = 4;
    uint    constant PAYRATE_DELAY = 40 minutes; // decreasing pay rate or deactivating requires a delay

    mapping(bytes32 => Brand) internal brands; // keccak(brand.memo) => Brand

    event Active(
        bytes32 indexed memoHash,
        bytes32         memo,       // the first 32 bytes of the memo
        uint            payRate,
        address indexed payer,
        uint            balance
    );
    event Deactive(bytes32 indexed memoHash);
    event Pay(
        bytes32 indexed memoHash,
        bytes32         memo,       // the first 32 bytes of the memo
        address indexed payer,
        address indexed payee,
        uint            amount
    );

    struct Brand {
        bytes   memo;
        address payer;
        uint    balance;
        SUint   payRate; // 18 decimals
    }

    constructor() public RefNetwork() {
        Brand storage brand = brands[keccak256(ENDURIO_MEMO)];
        brand.payer = address(this);
        brand.payRate.commit(ENDURIO_PAYRATE);
        brand.memo = ENDURIO_MEMO;
    }

    /**
     * Register/take over, deposit and active a brand
     */
    function registerBrand(
        bytes   calldata memo,
        uint    payRate,           // zero to disable auto activation
        uint    amount             // initial deposit
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
            require(payRate > brand.payRate.commited(), "pay rate too low for overtaking");
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
    function activate(bytes32 memoHash, uint payRate) external {
        Brand storage brand = brands[memoHash];
        address payer = brand.payer;
        require(msg.sender == payer, "current payer only");
        uint balance = brand.balance;
        require(balance >= payRate * ACTIVE_CONDITION_PAYRATE, "not enough deposit for given payrate");
        _setPayRate(brand, payRate);
        emit Active(memoHash, brand.memo.toBytes32(), payRate, payer, balance);
    }

    /**
     * request to deactivate the brand, with an optional delay param
     * the actual delay time is max(delay, PAYRATE_DELAY = 40 mins)
     */
    function deactivate(bytes32 memoHash, uint delay) external {
        Brand storage brand = brands[memoHash];
        require(msg.sender == brand.payer, "current payer only");
        require(brand.payRate.scheduled() > 0, "already pending for deactivation");
        if (delay == 0) {
            brand.payRate.schedule(0, PAYRATE_DELAY);
        } else {
            require(delay > PAYRATE_DELAY, "delay too short");
            require(block.timestamp + delay > block.timestamp, "delay too long"); // overflown
            brand.payRate.schedule(0, delay);
        }
        emit Deactive(memoHash);
    }

    /**
     * Increasing the pay rate take effect immediately,
     * reducing the payrate requires a delay of 40 mins
     */
    function _setPayRate(Brand storage brand, uint payRate) internal {
        if (payRate >= brand.payRate.commited()) {
            brand.payRate.commit(payRate);
        } else {
            brand.payRate.schedule(payRate, PAYRATE_DELAY);
        }
    }

    function withdraw(bytes32 memoHash) external {
        Brand storage brand = brands[memoHash];
        address payer = brand.payer;
        require(msg.sender == payer, "current payer only");
        require(brand.payRate.commited() == 0, "brand not deactivated");
        uint balance = brand.balance;
        require(balance > 0, "empty balance");
        _transfer(address(this), payer, balance);
    }

    /**
     * deposit to a brand regardless of its payer
     */
    function depositToBrand(bytes32 memoHash, uint amount) external {
        _depositToBrand(brands[memoHash], amount);
    }

    /**
     * deposit to a brand with given payer
     */
    function depositToBrand(bytes32 memoHash, address payer, uint amount) external {
        Brand storage brand = brands[memoHash];
        require(brand.payer == payer, "payer mismatches");
        _depositToBrand(brand, amount);
    }

    function _depositToBrand(Brand storage brand, uint amount) internal {
        _transfer(msg.sender, address(this), amount);
        brand.balance += amount;
    }

    /**
     * for PoR to pay for the miner
     */
    function _pay(
        Brand storage brand,
        address payee,
        uint rewardRate,
        bytes32 memoHash
    ) internal {
        address payer = brand.payer;
        if (payer == address(this)) {   // endur.io
            _mint(payee, rewardRate);   // mining reward
            emit Pay(memoHash, brand.memo.toBytes32(), payer, payee, rewardRate);
            return;
        }
        uint payRate = brand.payRate.commited();
        require(payRate > 0, "brand not active");
        uint amount = util.mulCap(payRate, rewardRate) / 1e18;
        uint balance = brand.balance;
        if (amount < balance) {
            balance -= amount; // safe
            brand.balance = balance;
            _transfer(address(this), payee, amount);
            emit Pay(memoHash, brand.memo.toBytes32(), payer, payee, amount);
            if (balance < payRate * ACTIVE_CONDITION_PAYRATE) {
                // schedule the deactivation
                brand.payRate.schedule(0, PAYRATE_DELAY);
                emit Deactive(memoHash);
            }
        } else {
            // exhaust the balance
            delete brand.balance;
            _transfer(address(this), payee, balance);
            emit Pay(memoHash, brand.memo.toBytes32(), payer, payee, balance);
            // forced commit a deactivation
            brand.payRate.commit(0);
            emit Deactive(memoHash);
        }
    }
}
