// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

/** @title DataStructure */
/** @author Zergity (https://endur.io) */

// solium-disable security/no-block-members

/**
 * Data Structure and common logic
 */
contract DataStructure {
    // Upgradable Contract Proxy //
    mapping(bytes4 => address) impls;   // function signature => implementation contract address
                                        // TODO: use ds to save a KECCAK on each proxy call
    // System Config //
    Config config = Config(
        address(0x0),               // owner
        0,                          // unused 12 bytes
        address(0x0),               // root
        0,                          // unused 12 bytes
        uint32(COM_RATE_UNIT / 2),  // 1/2 of miner reward
        1e3                         // halves the commission every rentScale of rent up the referral chain
    );

    // BrandMarket //
    mapping(bytes32 => mapping(address => Brand)) internal brands;

    bytes32 constant ENDURIO_MEMO_HASH  = keccak256("endur.io");
    uint192 constant ENDURIO_PAYRATE    = 1e18;

    // RefNet //
    mapping(address => Node) nodes;

    // Poof of Reference //
    mapping(bytes32 => mapping(bytes32 => Reward)) internal rewards;

    // constant
    // com-rate is [0;4,294,967,296)
    uint    constant COM_RATE_UNIT          = 1e9;

    // cut-back rate is [0;1e9]
    uint    constant CUTBACK_RATE_UNIT      = 1e9;
    uint    constant CUTBACK_RATE_CUSTOM    = 1<<31;    // or any value > CUTBACK_RATE_UNIT
    uint    constant CUTBACK_RATE_MASK      = (1<<30)-1;

    // events
    event GlobalConfig(bytes32 indexed key, uint value);
    event GlobalConfig(bytes32 indexed key, address value);

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
    event Submit(
        bytes32 indexed blockHash,
        bytes32 indexed memoHash,
        bytes32 indexed pkc,        // public commitment: either 20 bytes PKH or 32 bytes PK-Keccak
        address         payer,
        uint            value,
        uint            timestamp
    );
    event SubmitBy(
        address         submitter,
        uint            submitTime
    );
    event Claim(
        bytes32 indexed blockHash,
        bytes32 indexed memoHash,
        address indexed miner,
        address         payer,
        uint            value
    );
    event CommissionSkip(
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
    event CommissionPaid(
        address indexed payer,
        address indexed miner,
        address indexed payee,
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
    address owner;          // responsible for contract upgrade
    bytes12 ownerReserved;  // unused 12 bytes

    address root;           // owner of the root node, can be changed by owner
    bytes12 rootReserved;   // unused 12 bytes

    // commission = reward * comRate / COM_RATE_UNIT;
    uint32  comRate;

    // commission halves every rentScale of rent up the referral chain
    //     0: all commission go to the first node with non-zero rent
    //   max: close to flat-rate commission
    uint224 rentScale;
}

struct Brand {
    uint    balance;
    uint192 payRate;    // 18 decimals
    uint64  expiration;
}

struct Node {
    uint192     rent;
    uint64      expiration;

    address     parent;
    uint64      cooldownEnd;
    uint32      cutbackRate;        // cutBack = commission * cutbackRate / CUTBACK_RATE_UNIT

    address     cbtAddress;         // cutBackToken.transferFrom(noder, miner, tokenAmount)
    uint8       cbtRateDecimals;
    uint88      cbtRate;            // cutBackTokenAmount = commission * cutBackTokenRate / 10**cutBackTokenRateDecimals
}

struct Reward {
    uint32  rank;
    bytes28 commitment;     // keccak256(abi.encodePacked(payer, amount, timestamp, (pkk|pkh)))
}
