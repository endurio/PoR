// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./lib/util.sol";
import "./lib/rb.sol";
import "./lib/tadr.sol";
import "./DataStructure.sol";
import "./lib/abdk/ABDKMath64x64.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "./lib/time.sol";
import "./interface/Initializable.sol";

/**
 * Referral Network
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract RefNetwork is DataStructure, Initializable {
    uint constant MAX_INT64     = 0x7FFFFFFFFFFFFFFF;   // maximum int value ABDK Math64x64 can hold
    uint constant MAX_UINT192   = (1<<192) - 1;

    using rb for Balance;
    using tadr for TAddress;
    using libnode for Node;
    using ABDKMath64x64 for int128;

    uint    constant ROOT_EXP       = 5; // root commssion ~> TotalMined / 2^5
    int128  constant ROOT_EXP_64x64 = int128(ROOT_EXP << 64); // ABDKMath64x64.fromUInt(ROOT_EXP);

    uint constant EPOCH = 1 weeks;

    function initialize() public override {
        require(root == address(0x0), "already initialized");
        root = msg.sender;
        // init the root node at ROOT_ADDRESS, with parrent at ROOT_PARENT
        nodes[ROOT_ADDRESS].parent.forceTo(ROOT_PARENT, 0);
        // init the end of the first epoch
        epochEnd = time.next(EPOCH);
    }

    function getRoot() external view returns (address) {
        return root;
    }

    function setRoot(address newRoot) external {
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

    function deposit(uint amount) external {
        Node storage node = nodes[msg.sender];
        require(node.exists(), "no such node");
        _transfer(msg.sender, address(this), amount);
        node.balance.add(amount);
    }

    function withdraw(uint amount) external {
        Node storage node = nodes[msg.sender];
        // require(node.exists(), "no such node"); // the next line will verify node existent
        node.balance.sub(amount);
        _transfer(address(this), msg.sender, amount);
    }

    function setRent(uint rent) external {
        Node storage node = nodes[msg.sender];
        require(node.exists(), "no such node");
        require(rent != node.balance.getRate(), "unchanged rent");
        _pay(msg.sender);
        node.balance.setRate(rent);
    }

    function getRent() external view returns (uint) {
        Node storage node = nodes[msg.sender];
        require(node.exists(), "no such node");
        return node.balance.getRate();
    }

    /**
     * re-attach this node to the nearest ancestor with non-zero effective rent up the stream
     */
    function flatten(address noder) external {
        require(noder != ROOT_ADDRESS, "node account required"); // defensive
        Node storage node = nodes[noder];
        require(node.exists(), "no such node"); // defensive
        (address parent,) = node.parent.extract();
        address newParent = _findFlattenedParent(parent);
        if (newParent != parent) {
            // found new parent, re-attach
            node.parent.forceTo(parent);
        }
    }

    // TODO: use a rent threshold instead, governance?
    function _findFlattenedParent(address parent) internal view returns (address) {
        // keep searching up-stream until an ancestor with non-zero effective rent found
        while (parent != ROOT_ADDRESS && nodes[parent].getWeight() == 0) {
            (parent,) = nodes[parent].parent.extract();
        }
        return parent;
    }

    /**
     * pay the commision for the nodes and leave the remain to upstream,
     * Note: can be executed by anyone.
     */
     // solium-disable-next-line security/no-assign-params
    function payChain(address noder, uint depth) external {
        for (uint i = 0; i < depth; ++i) {
            noder = _pay(noder);
            if (noder == ROOT_PARENT) {
                return;
            }
        }
    }

    /**
     * pay the commision for the node and leave the remain to upstream
     * Note: can be executed by anyone.
     */
    function pay(address noder) external {
        _pay(noder);
    }

    /**
     * @return parent address, or ROOT_PARENT if there no more node nor commission
     */
    function _pay(address noder) internal returns (address) {
        Node storage node = nodes[noder];
        uint commission = node.commission;
        if (commission == 0) {
            return ROOT_PARENT;
        }
        if (noder == ROOT_ADDRESS) {
            // root node alway take all the remain commission
            node.balance.rawAdd(commission);
            uint rootC = util.addCap(epochTotalRootC, commission);
            // TBD: also check the accumulated cap here to prevent epochTotalReward overflow before an epoch pass?
            if (time.reach(epochEnd)) {
                _adaptGlobalLevelStep(rootC);
            } else {
                epochTotalRootC = rootC;
            }
            return ROOT_PARENT;
        }
        require(node.exists(), "node not exists");
        uint r = node.getWeight();
        if (r == 0) {
            // TBD: check flattening condition here?
            return _payUpstream(node, node.commission);
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
                node.balance.add(commission);
                return ROOT_PARENT; // no more commission to process
            }
            int128 a = ABDKMath64x64.divu(r, S).neg().exp_2(); // a = 1/2^(r/S) = 2^(-r/S)
            remain = a.mulu(commission);   // remain = commission / 2^(r/S)
        }

        node.balance.add(commission - remain);
        if (remain == 0) {
            return ROOT_PARENT; // no more commission to process
        }
        return _payUpstream(node, remain);
    }

    /**
     * @dev make sure this and _pay can never revert for root node
     */
    function _adaptGlobalLevelStep(uint rootC) internal {
        uint S = globalLevelStep;
        assert(S > 0);
        uint targetS = _newTargetS(rootC, S, epochTotalReward);
        if (targetS == 0) {
            return; // no adaption this time
        }
        globalLevelStep = Math.average(S, targetS);
        // reset the end of the next epoch
        epochEnd = time.next(EPOCH);
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
