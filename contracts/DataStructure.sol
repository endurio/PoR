// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./lib/bitcoin-spv/contracts/BytesLib.sol";
import "./lib/util.sol";
import "./lib/tadr.sol";
import "./lib/rb.sol";
import "./lib/suint192.sol";
import "./lib/time.sol";

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

    // libraries
    using rb for Balance;
    using tadr for TAddress;
    using libnode for Node;

    constructor() public ERC20("Endurio", "ENDR") {
    }

    /**
     * we don't do that here
     */
    receive() external payable {
        revert("No thanks!");
    }

    function _attach(address noder, address parent) internal {
        nodes[noder].parent.transferTo(parent);
    }

    /**
     * @dev shared for RefNet.commit and PoR.reward
     */
    function _payUpstream(Node storage node, uint commission) internal returns (address) {
        (address parent, uint96 mtime) = node.parent.extract();
        Node storage parentNode = nodes[parent];
        assert(parentNode.exists());

        if (time.reach(mtime)) { // matured
            parentNode.incCommissionCapped(commission);
            return parent;
        }

        // maturing address transfer here
        (uint dividend, uint divisor, address oldParent) = node.parent.maturingRate(mtime);
        assert(dividend <= divisor);
        uint newC = util.scaleDown(commission, dividend, divisor);
        parentNode.incCommissionCapped(newC);
        Node storage oldParentNode = nodes[oldParent];
        assert(oldParentNode.exists());
        oldParentNode.incCommissionCapped(commission - newC);

        return parent;
    }
}

struct Brand {
    uint    balance;
    uint    payRate;    // 18 decimals
    uint    expiration;
}

struct Node {
    TAddress    parent;
    Balance       balance;
    uint        commission; // total unclaimed commission for this node and upstream
}

library libnode {
    using tadr for TAddress;
    using rb for Balance;

    /**
     * nodes with parent is root, will have the expiredTime != 0
     * root node has expiredTime == 0 but the parent address is 0xFF..FF
     */
    function exists(Node storage n) internal view returns (bool) {
        return n.parent.exists();
    }

    // increase the node commission, the new value is safely capped at MAX_UINT256
    function incCommissionCapped(Node storage n, uint commission) internal {
        n.commission = util.addCap(n.commission, commission);
    }

    // a node's weight
    function getWeight(Node storage n) internal view returns (uint) {
        return n.balance.getWeight();
    }
}

struct Header {
    bytes32 merkleRoot;
    uint    target;
    uint32  timestamp;

    // PoR data
    int minable; // ref count for winner keys
    mapping(bytes32 => Transaction) winner; // keccak(brand.memo) => winning tx
}

struct Transaction {
    bytes32 id;
    uint    reward;
    address payer;
    bytes32 outpointTxLE;   // for P2WPKH
    uint32  outpointIdx;    // for P2WPKH               TODO: pack this with other field
    bytes20 pkh;            // for P2PKH, P2SH-P2WPKH
}
