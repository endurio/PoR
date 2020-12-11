// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

/**
 * Data Structure and common logic
 */
contract DataStructure {
    // Upgradable Contract Proxy //
    mapping(bytes4 => address) impls;   // function signature => implementation contract address
                                        // TODO: use ds to save a KECCAK on each proxy call
    address owner;                      // responsible for contract upgrade

    // System Config //
    Config config = Config(
        COM_RATE_UNIT / 2,  // 1/2 of miner reward
        1e9                 // levelStep: halves the commission every 1e9 of rent up the stream
    );

    // BrandMarket //
    mapping(bytes32 => mapping(address => Brand)) internal brands;

    bytes32 constant ENDURIO_MEMO_HASH  = keccak256("endur.io");
    uint192 constant ENDURIO_PAYRATE    = 1e18;

    // RefNet //
    mapping(address => Node) nodes;
    address root;                       // owner of the root node, can be changed by owner

    // Poof of Reference //
    mapping(bytes20 => address) internal miners; // pubkey bytes32 => address
    mapping(bytes32 => mapping(bytes32 => Reward)) internal rewards;

    // constant
    uint64  constant COM_RATE_UNIT  = 1 << 32;
    uint    constant MAX_UINT32     = (1<<32)-1;
    uint    constant MAX_UINT64     = (1<<64)-1;

    // events
    event GlobalConfig(uint comRate, uint levelStep);

    // TODO: Activated and Deactivaed?
    event Active(
        bytes32 indexed memoHash,
        address indexed payer,
        bytes           memo,
        uint            payRate,
        uint            balance,
        uint            expiration
    );
    event Deactive(
        bytes32 indexed memoHash,
        address indexed payer
    );
    event Mined(
        bytes32 indexed memoHash,
        address indexed payer,
        bytes20 indexed pkh,
        uint            amount,
        uint            timestamp,
        bytes32         blockHash
    );
    event Rewarded(
        bytes32 indexed memoHash,
        address indexed payer,
        address indexed miner,
        uint            value
    );
    event CommissionLost(
        address indexed payer,
        address indexed miner,
        uint            value
    );
    event CommissionRoot(
        address indexed payer,
        address indexed miner,
        uint            value
    );
    
    /**
     * we don't do that here
     */
    receive() external payable {
        revert("No thanks!");
    }
}

struct Config {
    // commission = reward * comRate / COM_RATE_UNIT;
    uint64  comRate;

    // commission halves every globalLevelStep of rent up the stream
    // globalLevelStep must never be zero.
    //     0: all commission go to the miner himself
    //     1: almost all commission go to the first node with non-zero rent
    uint192 levelStep;
}

struct Brand {
    uint    balance;
    uint    payRate;    // 18 decimals
    uint    expiration;
}

struct Node {
    uint        balance;    // BurningBalance
    bytes32     parent;
    address     prevParent;
    uint64      cooldownEnd;
    uint32      cutBackRate;// cutBack = commission * cutBackRate / MAX_UINT32
}

// TODO: test whether this is tightly packed
struct Reward {
    uint32  rank;
    bytes28 commitment;     // keccak256(abi.encodePacked(payer, pkh, amount, timestamp))
}
