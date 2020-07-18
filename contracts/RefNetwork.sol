// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

import "./lib/util.sol";
import "./lib/lval.sol";
import "./lib/tadr.sol";
import "./ENDR.sol";
import "./lib/abdk/ABDKMath64x64.sol";
import "@openzeppelin/contracts/math/Math.sol";

/**
 * Referral Network
 */
contract RefNetwork is ENDR {
    uint constant MAX_INT64     = 0x7FFFFFFFFFFFFFFF;   // maximum int value ABDK Math64x64 can hold
    uint constant MAX_UINT192   = (1<<192) - 1;

    using lval for LUint;
    using tadr for TAddress;
    using libnode for Node;
    using ABDKMath64x64 for int128;

    address constant ROOT_ADDRESS   = address(0x0);
    address constant ROOT_PARENT    = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
    uint    constant ROOT_EXP       = 5; // root commssion ~> TotalMined / 2^5
    int128  constant ROOT_EXP_64x64 = int128(ROOT_EXP << 64); // ABDKMath64x64.fromUInt(ROOT_EXP);

    mapping(address => Node) nodes;

    // system variables
    uint S = 1;         // level step: commission half for every S of rent up the stream
    // uint totalRent;     // total active rent of the network
    uint epochEnd;
    uint epochTotalMined;   // track the total reward for this epoch;
    uint epochTotalRootC;   // track the total commission for root node for this epoch;

    uint constant EPOCH = 1 weeks;

    constructor() public ENDR() {
        // init the root node at ROOT_ADDRESS, with parrent at ROOT_PARENT
        Node storage root = nodes[ROOT_ADDRESS];
        root.parent.forceTo(ROOT_PARENT, 0);
        // init the end of the first epoch
        epochEnd = block.timestamp + EPOCH;
    }

    /**
     * init a node, attach or re-attach to parent node
     */
    function attach(address parent) external {
        require(nodes[parent].exists(), "parent not exist");
        _attach(msg.sender, parent);
    }

    function _attach(address noder, address parent) internal {
        nodes[noder].parent.transferTo(parent);
    }

    /**
     * reward the miner an amount of token, and commit another amount of token to the upstream referal
     *
     * Note: half of the reward is distributed to miner, the other half is for upstream commission.
     */
    function reward(address miner, uint amount) internal {
        Node storage node = nodes[miner];
        if (!node.exists()) {
            _attach(miner, ROOT_ADDRESS);
        }
        assert(node.exists());
        uint commission = amount >> 1;
        node.balance.inc(amount - commission); // safe
        commitToUpstream(node, commission);
    }

    /**
     * claim the accumulate commission, can be executed by anyone
     */
    function commitChain(address noder, uint depth) external {
        for (uint i = 0; i < depth; ++i) {
            noder = _commit(noder);
            if (noder == ROOT_PARENT) {
                return;
            }
        }
    }

    /**
     * claim the accumulate commission, can be executed by anyone
     */
    function commit(address noder) external {
        _commit(noder);
    }

    function _commit(address noder) internal returns (address) {
        Node storage node = nodes[noder];
        uint commission = node.commission;
        if (noder == ROOT_ADDRESS) {
            // root node alway take all the remain commission
            node.balance.rawInc(commission);
            if (epochEnd <= block.timestamp) { // TODO: also check the accumulated cap here
                adaptS(commission);
            }
            return ROOT_PARENT;
        }
        require(node.exists(), "node not exists");
        uint r = node.balance.getEffectiveLeakingRate();
        if (r == 0) {
            // TODO: check clean up condition here?
            return commitToUpstream(node, node.commission);
        }
        // S is a global params, adjust so that root node get approximately 1/32 of the token minted.
        uint remain;
        if (S <= 1) {
            // use minimum value for S if it's zero
            remain = commission >> r;
        } else {
            if (r / S > MAX_INT64) { // overflow 64x64
                // take all the remain commission, leave nothing behind
                node.balance.inc(commission);
                return ROOT_PARENT; // no more commission to process
            }
            int128 a = ABDKMath64x64.divu(r, S).neg().exp_2(); // a = 1/2^(r/S) = 2^(-r/S)
            remain = a.mulu(commission);   // remain = commission / 2^(r/S)
        }

        node.balance.inc(commission - remain);
        if (remain == 0) {
            return ROOT_PARENT; // no more commission to process
        }
        return commitToUpstream(node, remain);
    }

    /**
     * @dev make sure this and _commit can never revert for root node
     */
    function adaptS(uint rootC) internal {
        uint targetS = _newTargetS(rootC);
        S = Math.average(S, targetS);
    }

    /**
     * @dev should never be reverted
     * @return S*log_2(C/rootC)/ROOT_EXP
     */
    function _newTargetS(uint rootC) internal view returns (uint) {
        uint _S = S > 1 ? S : 1; // use minimum value for S if it's zero
        uint C = epochTotalMined;
        if (rootC <= 1) { // root got (almost) no commission
            if (C <= 1) {
                return; // too little data to process
            }
            uint lc = util.mostSignificantBit(C); // lc = log2(C/rootC)
            return _S * lc / ROOT_EXP;
        }

        { // scope for local variables
        uint c = C / rootC;
        if (c > MAX_INT64) { // overflow 64x64
            uint lc = util.mostSignificantBit(c); // lc = log2(C/rootC)
            return _S * lc / ROOT_EXP;
        }
        }

        int128 c = ABDKMath64x64.divu(C, rootC);
        int128 lc = c.log_2();
        return lc.div(ROOT_EXP_64x64).muluc(_S);
    }

    function commitToUpstream(Node storage node, uint commission) internal returns (address) {
        (address parent, uint96 mtime) = node.parent.extract();
        Node storage parentNode = nodes[parent];
        assert(parentNode.exists());

        if (mtime <= block.timestamp) { // matured
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

struct Node {
    TAddress    parent;
    LUint       balance;
    uint        commission; // total unclaimed commission for this node and upstream
}

library libnode {
    using tadr for TAddress;

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
}
