// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./lib/util.sol";
import "./lib/lval.sol";
import "./lib/tadr.sol";
import "./DataStructure.sol";
import "./lib/abdk/ABDKMath64x64.sol";
import "@openzeppelin/contracts/math/Math.sol";

/**
 * Referral Network
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract RefNetwork is DataStructure {
    uint constant MAX_INT64     = 0x7FFFFFFFFFFFFFFF;   // maximum int value ABDK Math64x64 can hold
    uint constant MAX_UINT192   = (1<<192) - 1;

    using lval for LUint;
    using tadr for TAddress;
    using libnode for Node;
    using ABDKMath64x64 for int128;

    uint    constant ROOT_EXP       = 5; // root commssion ~> TotalMined / 2^5
    int128  constant ROOT_EXP_64x64 = int128(ROOT_EXP << 64); // ABDKMath64x64.fromUInt(ROOT_EXP);

    uint constant EPOCH = 1 weeks;

    constructor() public {
        root = msg.sender;
        // init the root node at ROOT_ADDRESS, with parrent at ROOT_PARENT
        nodes[ROOT_ADDRESS].parent.forceTo(ROOT_PARENT, 0);
        // init the end of the first epoch
        epochEnd = block.timestamp + EPOCH;
    }

    function changeRoot(address newRoot) external {
        require(msg.sender == root || msg.sender == owner, "owner or root only");
        root = newRoot;
    }

    /**
     * init a node, attach or re-attach to parent node
     */
    function attach(address parent) external {
        require(nodes[parent].exists(), "parent not exist");
        _attach(msg.sender, parent);
    }

    /**
     * claim the accumulate commission, can be executed by anyone
     */
     // solium-disable-next-line security/no-assign-params
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

    /**
     * @return parent address, or ROOT_PARENT if there no more node nor commission
     */
    function _commit(address noder) internal returns (address) {
        Node storage node = nodes[noder];
        uint commission = node.commission;
        if (noder == ROOT_ADDRESS) {
            // root node alway take all the remain commission
            node.balance.rawInc(commission);
            uint rootC = util.addCap(epochTotalRootC, commission);
            // TBD: also check the accumulated cap here to prevent epochTotalReward overflow before an epoch pass?
            if (epochEnd <= block.timestamp) {
                adaptGlobalLevelStep(rootC);
            } else {
                epochTotalRootC = rootC;
            }
            return ROOT_PARENT;
        }
        require(node.exists(), "node not exists");
        uint r = node.balance.getEffectiveLeakingRate();
        if (r == 0) {
            // TODO: check clean up condition here?
            return commitToUpstream(node, node.commission);
        }
        // globalLevelStep is a global params, adjust so that root node get approximately 1/32 of the token rewarded.
        uint S = globalLevelStep;
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
    function adaptGlobalLevelStep(uint rootC) internal {
        uint S = globalLevelStep;
        assert(S > 0);
        uint targetS = _newTargetS(rootC, S, epochTotalReward);
        if (targetS == 0) {
            return; // no adaption this time
        }
        globalLevelStep = Math.average(S, targetS);
        // reset the end of the next epoch
        epochEnd = block.timestamp + EPOCH;
        delete epochTotalRootC;
        delete epochTotalReward;
    }

    /**
     * @dev should never be reverted
     * @return S*log_2(C/rootC)/ROOT_EXP or 0 to cancel the target adapting process
     */
    function _newTargetS(uint rootC, uint S, uint C) internal pure returns (uint) {
        if (rootC <= 1) { // root got (almost) no commission
            if (C <= 1) {
                return 0; // too little data to process
            }
            uint lc = util.mostSignificantBit(C); // lc = log2(C/rootC)
            return S * lc / ROOT_EXP;
        }

        { // scope for local variables
        uint c = C / rootC;
        if (c > MAX_INT64) { // overflow 64x64
            uint lc = util.mostSignificantBit(c); // lc = log2(C/rootC)
            return S * lc / ROOT_EXP;
        }
        }

        int128 c = ABDKMath64x64.divu(C, rootC);
        int128 lc = c.log_2();
        return lc.div(ROOT_EXP_64x64).muluc(S);
    }
}
