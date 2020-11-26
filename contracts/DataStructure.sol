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
    mapping(bytes32 => Header) internal headers;

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
    event Rewarded(
        bytes32 indexed memoHash,
        address indexed payer,
        address indexed miner,
        uint            value
    );
    event CommissionAvailable(
        address indexed miner,
        bytes32 indexed memoHash,
        bytes32 indexed blockHash
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
    uint        commission; // total unclaimed commission for this node and upstream
    bytes32     parent;
    address     prevParent;
    uint64      cooldownEnd;
    uint32      cutBackRate;// cutBack = commission * cutBackRate / MAX_UINT32
}

struct Header {
    bytes32 merkleRoot;
    uint    target;
    address relayer;
    uint32  timestamp;
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
    uint32  nBounty;        // bounty output count
    bytes32 bounty;
}

/// timestamp can be shared between many memoHash of the same block,
/// but this will be changed to commitment later so let's keep it here
struct Reward {
    bytes32 txid;       // TODO: store rank instead
    uint    amount;
    address payer;
    uint96  timestamp;  // TODO: test whether this is tightly packed
    bytes20 pkh;
}
