// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Data Structure and common logic
 */
contract DataStructure is ERC20 {
    // Upgradable Contract Proxy //
    mapping(bytes4 => address) impls;   // function signature => implementation contract address
                                        // TODO: use ds to save a KECCAK on each proxy call
    address owner;                      // responsible for contract upgrade

    // BrandMarket //
    mapping(bytes32 => mapping(address => Brand)) internal brands;

    bytes32 constant ENDURIO_MEMO_HASH  = keccak256("endur.io");
    uint192 constant ENDURIO_PAYRATE    = 1e18;

    // RefNet //
    mapping(address => Node) nodes;
    address root;                       // owner of the root node, can be changed by owner

    // System Variables
    /**
     * @dev commission half for every globalLevelStep of rent up the stream.
     * @dev globalLevelStep must never be zero.
     */
    uint globalLevelStep = 1;

    // uint totalRent;          // total active rent of the network
    uint epochEnd;
    uint epochTotalReward;      // track the total reward for this epoch;
    uint epochTotalRootC;       // track the total commission for root node for this epoch;

    // Poof of Reference //
    mapping(bytes20 => address) internal miners; // pubkey bytes32 => address
    mapping(bytes32 => Header) internal headers;

    // constant
    address constant ROOT_ADDRESS               = address(0x0);
    address constant ROOT_PARENT                = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);

    // events
    event Active(
        bytes   indexed memo,
        address indexed payer,
        uint            payRate,
        uint            balance,
        uint            expiration
    );
    event Deactive(
        bytes32 indexed memoHash,
        address indexed payer
    );
    event Reward(
        bytes32 indexed memoHash,
        address indexed payer,
        address indexed payee,
        uint            amount
    );
    event CommissionAvailable(
        address indexed miner,
        bytes32 indexed memoHash,
        bytes32 indexed blockHash
    );

    constructor() public ERC20("Endurio", "ENDR") {
    }

    /**
     * we don't do that here
     */
    receive() external payable {
        revert("No thanks!");
    }
}

struct Brand {
    uint    balance;
    uint    payRate;    // 18 decimals
    uint    expiration;
}

struct Node {
    uint        balance;    // BurningBalance
    uint        commission; // total unclaimed commission for this node and upstream
    bytes32     parent;
    address     prevParent;
    uint64      cooldownEnd;
    uint32      cutBackRate;// cutBack = commission * cutBackRate / MAX_UINT32
}

struct Header {
    bytes32 merkleRoot;
    uint    target;
    uint32  timestamp;

    // PoR data
    int minable; // ref count for winner keys
    mapping(bytes32 => Transaction) winner; // keccak(brand.memo) => winning tx
}

enum TxState {
    CLAIMED,
    PKH,        // for P2PKH, P2SH-P2WPKH
    OUTPOINT    // for P2WPKH (along with outpointIdx)
}

/**
 * The winner tx is the tx with the smallest value of KECCAK(BlockHash + id)
 *
 * The id field is cleared in claim/claimWithPrevTx to mark the transaction is ready
 * for the upstream commission to be paid.
 *
 * KECCAK(BlockHash + miner) is used as the random seed for the upstream commission selection.
 *
 * minerData store miner data depend on the state:
 *  CLAIMED:     miner address
 *  PKH:         PKH of the miner
 *  OUTPOINT:    the first 20 bytes of outputTxLE
 */
struct Transaction {
    bytes32 id;
    uint    reward;
    address payer;
    bytes20 minerData;
    uint32  outpointIdx;    // for P2WPKH (along with minderData.OUTPOINT)
    TxState state;
}
