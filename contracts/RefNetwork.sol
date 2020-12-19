// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-block-members

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./Token.sol";
import "./lib/CapMath.sol";
import "./lib/MaturingAddress.sol";
import "./DataStructure.sol";
import "./lib/abdk/ABDKMath64x64.sol";
import "./lib/time.sol";
import "./lib/util.sol";
import "./interface/Initializable.sol";
import "./interface/IRefNet.sol";

/**
 * Referral Network
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract RefNetwork is DataStructure, Token, IRefNet, Initializable {
    using MaturingAddress for bytes32;
    using libnode for Node;
    using ABDKMath64x64 for int128;

    uint    constant MAX_UINT64         = (1<<64)-1;

    uint    constant ROOT_COM_RATE      = 32;       // root commission chance = 1/32
    uint    constant RENT_CD            = 1 weeks;

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
     * @param amount is rounded down to multiple of rent
     */
    function deposit(uint amount) external returns (uint rent, uint expiration) {
        require(amount > 0, "!amount");
        Node storage node = nodes[msg.sender];
        (rent, expiration) = (node.rent, node.expiration);
        require(rent > 0, "!rent");
        if (expiration == 0) {
            expiration = time.blockTimestamp(); // initialize a rent
        } else {
            uint elapsed = time.elapse(expiration);
            if (elapsed > 0) {  // expired
                // newRent = (rent/2**(elapsed/CD))*(1-elapsed%CD/CD/2)
                // exponential decay over weeks
                rent >>= elapsed/RENT_CD;
                // linear decay from 1 to 0.5 during the week
                rent = SafeMath.sub(rent, CapMath.checkedScale(rent, elapsed%RENT_CD, RENT_CD*2), "decaying rent overflow");
                if (rent == 0) {
                    rent = 1;   // smallest value
    }
                node.rent = uint192(rent);
                expiration = time.blockTimestamp(); // clear the expired rent
            }
        }
        uint duration = amount / rent;
        require(duration > 0, "!duration");
        _burn(msg.sender, duration*rent);   // safe
        expiration = SafeMath.add(expiration, duration);             // new balance too high for current rent
        require(expiration <= MAX_UINT64, "expiration overflow ui64");  // new balance too high for current rent
        node.expiration = uint64(expiration);
        // return (rent, expiration);
    }

    /**
     * withraw and contract the node expiration, empty the balance on over-withdraw
     * @param amount is rounded down to multiple of rent
     */
    function withdraw(uint amount) external returns (uint rent, uint expiration) {
        require(amount > 0, "!amount");
        Node storage node = nodes[msg.sender];
        (rent, expiration) = (node.rent, node.expiration);
        require(rent > 0, "!rent");
        uint duration = amount / rent;
        require(duration > 0, "!duration");
        uint remain = time.remain(expiration);
        require(remain > 0, "expired");
        if (duration > remain) {
            duration = remain;  // over withdraw, exhaust the balance instead of revert
        }
        node.expiration = uint64(SafeMath.sub(expiration, duration));   // overflowable
        _mint(msg.sender, duration*rent);
        // return (rent, expiration);
    }

    /// some of the balance will be lost due to rounding up
    function setRent(uint newRent) external returns (uint rent, uint expiration) {
        require(newRent > 0, "!rent");
        Node storage node = nodes[msg.sender];
        expiration = node.expiration;
        if (expiration == 0) {  // uninitialized node
            node.rent = uint192(newRent);
            return (newRent, expiration);
    }
        require(!time.reach(expiration), "expired");        // deposit due rent and some more first
        rent = node.rent;
        require(newRent / 2 <= rent, "new rent too high");
        require(time.reach(node.cooldownEnd), "cooldown");
        node.cooldownEnd = uint64(time.next(RENT_CD));  // overflowable: unexploitable
        uint remain = rent * time.remain(expiration);   // unoverflowable: ui192 * ui64
        expiration = time.next(remain / newRent);
        require(expiration <= MAX_UINT64, "expiration overflow ui64");   // newRent too low for current remain balance
        (node.rent, node.expiration) = (uint192(newRent), uint64(expiration));
        rent = newRent; // return (newRent, expiration);
    }

    function getNodeDetails(address noder) external view returns (
        uint    rent,
        uint    expiration,
        uint    cooldownEnd,
        uint    cutBackRate,
        address parent,
        uint    duration,
        uint    maturedTime,
        address prevParent
    ) {
        Node storage node = nodes[noder];
        rent = node.rent;
        expiration = node.expiration;
        cooldownEnd = node.cooldownEnd;
        cutBackRate = node.cutBackRate;
        (parent, duration, maturedTime) = node.parent.unpack();
        prevParent = node.prevParent;
    }

    function reward(
        address miner,
        address payer,
        uint amount,
        bytes32 memoHash,
        bytes32 seed
    ) external override {
        require(msg.sender == address(this), "!internal");  // must be called from other implemenetation
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
        uint expiration = n.expiration;
        if (time.reach(expiration)) {
            return 0;
        }
        return n.rent;
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
