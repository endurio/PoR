// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "./Token.sol";
import "./lib/CapMath.sol";
import "./lib/BurningBalance.sol";
import "./lib/MaturingAddress.sol";
import "./DataStructure.sol";
import "./lib/abdk/ABDKMath64x64.sol";
import "./lib/time.sol";
import "./interface/Initializable.sol";
import "./interface/IRefNet.sol";

/**
 * Referral Network
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract RefNetwork is DataStructure, Token, IRefNet, Initializable {
    uint constant MAX_INT64     = (1<<63)-1;   // maximum int value ABDK Math64x64 can hold
    uint constant MAX_UINT192   = (1<<192)-1;

    using BurningBalance for uint;
    using MaturingAddress for bytes32;
    using libnode for Node;
    using ABDKMath64x64 for int128;

    uint    constant ROOT_COM_RATE      = 32;       // root commission chance = 1/32
    uint    constant RENT_CD            = 1 weeks;
    uint    constant FREEZING_DURATION  = 1 weeks;  // node expired for this long can be flatten (by anyone)

    uint constant EPOCH = 1 weeks;

    constructor() public Token("", "") {}

    function initialize() public override {
        require(root == address(0x0), "already initialized");
        root = msg.sender;
    }

    function setRoot(address newRoot) external {
        require(msg.sender == root || msg.sender == owner, "!owner");
        root = newRoot;
    }

    function setGlobalConfig(uint64 comRate, uint192 levelStep) external {
        require(msg.sender == root || msg.sender == owner, "!owner");
        config.comRate = comRate;
        config.levelStep = levelStep;
        emit GlobalConfig(comRate, levelStep);
    }

    function getGlobalConfig() external view returns (uint64 comRate, uint192 levelStep) {
        return (config.comRate, config.levelStep);
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

    function reward(
        address miner,
        address payer,
        uint amount,
        bytes32 memoHash,
        bytes32 seed
    ) external override returns (bool ok) {
        require(msg.sender == address(this), "from claim only");
        uint commission = CapMath.scaleDown(amount, config.comRate, COM_RATE_UNIT);
        uint claimable = _claimReward(memoHash, payer, amount+commission);
        if (claimable < amount) {
            amount = claimable;
            commission = 0;
        } else {
            commission = claimable - amount;
        }
        if (commission > 0) {
            seed = keccak256(abi.encodePacked(memoHash, seed));
            uint cutBack = _payCommission(miner, payer, commission, uint(seed));
            amount += cutBack;
        }
        if (payer == address(0x0)) {
            _mint(miner, amount);
        } else {
            _transfer(address(this), miner, amount);
        }
        emit Rewarded(memoHash, payer, miner, amount);
        return true;    // go ahead and clean up the winning tx
    }

    /**
     * take the token from the brand (or mint for ENDURIO) to pay for miner and the network
     */
    function _claimReward(
        bytes32 memoHash,
        address payer,
        uint    amount
    ) internal returns (uint) {
        if (memoHash == ENDURIO_MEMO_HASH) {
            // _mint(address(this), amount);
            return amount;
        }
        Brand storage brand = brands[memoHash][payer];
        uint balance = brand.balance;
        if (amount < balance) {
            brand.balance -= amount; // safe
            return amount;
        }
        delete brands[memoHash][payer];
        emit Deactive(memoHash, payer);
        return balance;
    }

    function _payCommission(
        address miner,
        address payer,
        uint amount,
        uint seed
    ) internal returns (uint cutBackCommission) {
        // there's always 1/32 chance that the commission will go to root
        if (seed % ROOT_COM_RATE == 0) {
            if (payer == address(0x0)) {
                _mint(root, amount);
            } else {
                _transfer(address(this), root, amount);
            }
            // this short-circuit slews the CommissionLost rate below
            emit CommissionRoot(payer, miner, amount);
            return 0;
        }

        // TODO: short circuit for no parent and no balance
        int128 x = int128(seed & MAX_UINT64);   // random 64x64 number in [0,1)
        uint distance = x.log_2().neg().muluc(config.levelStep);

        Node storage node = nodes[miner];
        address noder;
        for (uint rent; (rent = node.getRent()) < distance; node = nodes[noder]) {
            distance -= rent;
            noder = node.pickParent(seed);
            if (noder == address(0x0)) {
                emit CommissionLost(payer, miner, amount);
                return 0;   // no commission paid, no cut back
            }
        }

        uint cutBack = CapMath.scaleDown(amount, node.cutBackRate, MAX_UINT32);
        if (payer == address(0x0)) {
            _mint(noder, amount-cutBack);
        } else {
            _transfer(address(this), noder, amount-cutBack);
        }
        // emit Commission(noder, payer, miner)
        return cutBack;
    }
}

library libnode {
    uint constant MAX_UINT64 = (1<<64)-1;

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

    // a node's weight
    function getRent(Node storage n) internal view returns (uint) {
        return n.balance.getRate();
    }

    // pick parent or prevParent using a random uint seed
    function pickParent(Node storage n, uint seed) internal view returns (address) {
        (address parent, uint duration, uint maturedTime) = n.parent.unpack();
        if (time.reach(maturedTime)) {
            return parent;  // fully matured, no luck require
        }
        uint elapsed = time.elapse(maturedTime - duration);
        // it's ok to be a tiny bit biased toward parent
        if (seed % duration < elapsed) {
            return parent;  // lucky
        }
        return n.prevParent;
    }
}
