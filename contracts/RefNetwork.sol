// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./lib/util.sol";
import "./lib/BurningBalance.sol";
import "./lib/MaturingAddress.sol";
import "./DataStructure.sol";
import "./lib/abdk/ABDKMath64x64.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "./lib/time.sol";
import "./interface/Initializable.sol";
import "./interface/ICommissionReceiver.sol";

/**
 * Referral Network
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract RefNetwork is DataStructure, ICommissionReceiver, Initializable {
    uint constant MAX_UINT64    = 0xFFFFFFFFFFFFFFFF;
    uint constant MAX_INT64     = 0x7FFFFFFFFFFFFFFF;   // maximum int value ABDK Math64x64 can hold
    uint constant MAX_UINT192   = (1<<192) - 1;

    using BurningBalance for uint;
    using MaturingAddress for bytes32;
    using libnode for Node;
    using ABDKMath64x64 for int128;

    uint    constant ROOT_EXP           = 5; // root commssion ~> TotalMined / 2^5
    int128  constant ROOT_EXP_64x64     = int128(ROOT_EXP << 64); // ABDKMath64x64.fromUInt(ROOT_EXP);
    uint    constant RENT_CD            = 1 weeks;
    uint    constant FREEZING_DURATION  = 1 weeks;  // node expired for this long can be flatten (by anyone)

    uint constant EPOCH = 1 weeks;

    function initialize() public override {
        require(root == address(0x0), "already initialized");
        root = msg.sender;
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
        nodes[msg.sender].attach(parent);
    }

    /**
     * deposit and extend the node expiration.
     * Expired node can still deposit and resume if all the down-time rent is also paid.
     */
    function deposit(uint amount) external {
        Node storage node = nodes[msg.sender];
        _burn(msg.sender, amount);
        node.balance = node.balance.deposit(amount);
    }

    /**
     * withraw and contract the node expiration, revert on over-withdraw
     * use empty() to withdraw all remain rent balance
     */
    function withdraw(uint amount) external {
        Node storage node = nodes[msg.sender];
        node.balance = node.balance.withdraw(amount);
        _mint(msg.sender, amount);
    }

    function empty() external {
        Node storage node = nodes[msg.sender];
        uint remain = node.balance.getRemain();
        delete node.balance;
        _transfer(address(this), msg.sender, remain);
    }

    function setRent(uint rent) external {
        Node storage node = nodes[msg.sender];
        uint balance = node.balance;
        (uint oldRent, uint expiration) = balance.unpack();
        require(!time.reach(expiration), "node expired");       // deposit due rent and some more first
        require(rent / 2 < oldRent, "restricted rent value");   // also revert on uninitialized node
        require(time.reach(node.cooldownEnd), "rent cooldown");
        node.balance = balance.setRate(rent);
        node.cooldownEnd = uint64(time.next(RENT_CD));  // unsafe
    }

    function getNodeDetails(address noder) external view returns (
        uint    balance,
        uint    rent,
        uint    cooldownEnd,
        uint    commission,
        address parent,
        uint    duration,
        uint    maturedTime,
        address prevParent
    ) {
        Node storage node = nodes[noder];
        balance = node.balance.getRemain();
        rent = node.balance.getRate();
        cooldownEnd = node.cooldownEnd;
        commission = node.commission;
        (parent, duration, maturedTime) = node.parent.unpack();
        prevParent = node.prevParent;
    }

    function pay(
        address miner,
        address payer,
        uint amount
    ) external override returns (uint cutBackCommission) {
        require(msg.sender == address(this), "from claim only");
        // TODO
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

library libnode {
    uint constant MAX_UINT64 = 0xFFFFFFFFFFFFFFFF;

    using MaturingAddress for bytes32;
    using BurningBalance for uint;

    function attach(Node storage n, address newParent) internal {
        bytes32 parent = n.parent;
        if (parent == 0) { // uninitialized
            n.parent = MaturingAddress.pack(newParent, 0, time.blockTimestamp());
            return;
        }
        // new maturing process starts from the last matured time if the current address is matured,
        // from the last start time otherwise
        uint lastMaturedTime = parent.getMaturedTime();
        if (!time.reach(lastMaturedTime)) { // not matured
            lastMaturedTime = parent.getStartTime();
        } else { // matured
            n.prevParent = parent.getAddress();
        }
        // new maturing duration is the time elapsed from the last parent matured time
        uint duration = time.elapse(lastMaturedTime);
        uint maturedTime = time.next(duration);
        // overflow check
        if (maturedTime > MAX_UINT64 || maturedTime < time.blockTimestamp()) {
            maturedTime = MAX_UINT64; // cap the result
            duration = time.remain(maturedTime);
        }
        n.parent = MaturingAddress.pack(newParent, duration, maturedTime);
    }

    // TODO: function revertParentTransfer

    // increase the node commission, the new value is safely capped at MAX_UINT256
    function incCommissionCapped(Node storage n, uint commission) internal {
        // n.commission = util.addCap(n.commission, commission);
    }

    // a node's weight
    function getWeight(Node storage n) internal view returns (uint) {
        return n.balance.getRate();
    }
}
