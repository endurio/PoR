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

    /// some of the balance will be lost due to rounding
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

    function setCutbackRate(
        address token,
        uint rate,
        uint decimals
    ) external {
        Node storage node = nodes[msg.sender];
        if (token != address(0x0)) {
            require(rate < 1<<88, "custom cutback rate exceeds 88 bits");
            require(decimals < 1<<8, "custom cutback decimals exceeds 8 bits");
            node.cutbackRate = uint32(CUTBACK_RATE_CUSTOM);   // set the custom token flag
            node.cbtAddress = token;
            node.cbtRate = uint88(rate);
            node.cbtRateDecimals = uint8(decimals);
            return;
        }
        require(rate <= CUTBACK_RATE_UNIT, "native cutback rate exceeds 1e9");
        uint cutbackRate = node.cutbackRate;
        bool cbt = cutbackRate > CUTBACK_RATE_UNIT;  // use the highest bit for cbt flag
        if (cbt) {  // clear the custom token
            delete node.cbtAddress;
            delete node.cbtRate;
            delete node.cbtRateDecimals;
        }
        node.cutbackRate = uint32(rate);
    }

    function getNodeDetails(address noder) external view returns (
        uint    rent,
        uint    expiration,
        uint    cooldownEnd,
        uint    cutbackRate,
        address parent,
        uint    duration,
        uint    maturedTime,
        address prevParent
    ) {
        Node storage node = nodes[noder];
        rent = node.rent;
        expiration = node.expiration;
        cooldownEnd = node.cooldownEnd;
        cutbackRate = node.cutbackRate;
        (parent, duration, maturedTime) = node.parent.unpack();
        prevParent = node.prevParent;
    }

    function reward(
        address miner,
        address payer,
        uint amount,
        bytes32 memoHash,
        bytes32 seed,
        bool skipCommission
    ) external override {
        require(msg.sender == address(this), "!internal");  // must be called from other implemenetation

        { // stack too deep
        (uint rewarded, bool empty) = _payByBrand(memoHash, payer, miner, amount);
        emit Rewarded(memoHash, payer, miner, rewarded);
        if (empty) {
            return;  // brand has no more fund to pay for commission
        }
        }

        uint uiSeed = uint(keccak256(abi.encodePacked(memoHash, seed)));

        // there's always 1/32 chance that the raw commission will go to root
        if (uiSeed % ROOT_COM_RATE == 0) {
            // reuse amount for actual rewarded amount
            (amount,) = _payByBrand(memoHash, payer, root, amount);
            emit CommissionRoot(payer, miner, amount);
            return;
        }

        if (skipCommission) {
            emit CommissionSkip(payer, miner, amount);
            return;
        }

        uint commission = CapMath.checkedScale(amount, config.comRate, COM_RATE_UNIT);
        if (commission > 0) {
            // DEBUG & TEST //
            // Use config.comRate as an addition entropy for statistical testing.
            // Ideally, this should be removed in production, not a disaster if we forgot.
            uiSeed = uint(keccak256(abi.encodePacked(uiSeed, config.comRate)));

            _commitCommission(memoHash, payer, miner, commission, uiSeed);
        }
    }

    function _payByBrand(
        bytes32 memoHash,
        address payer,
        address payee,
        uint    amount
    ) internal returns (uint, bool) {
        if (payer == address(0x0)) {
            _mint(payee, amount);
            return (amount, false);
        }

        Brand storage brand = brands[memoHash][payer];
        uint balance = brand.balance;
        if (amount < balance) {
            brand.balance -= amount; // safe
            _transfer(address(this), payee, amount);
            return (amount, false);
        }
        delete brands[memoHash][payer];
        emit Deactive(memoHash, payer);
        _transfer(address(this), payee, balance);
        return (balance, true);    // no more balance to pay
    }

    function _commitCommission(
        bytes32 memoHash,
        address payer,
        address miner,
        uint    amount,
        uint    seed
    ) internal {
        // TODO: lazy evaluation this
        // seed = uint(keccak256(abi.encodePacked(seed))); // rehash
        int128 x = int128(seed & MAX_UINT64);   // random 64x64 number in [0,1)
        uint distance = x.log_2().neg().muluc(config.levelStep);

        address noder = miner;
        while(true) {
            Node storage node = nodes[noder];
            uint rent = node.getRent();
            // short-circuit for zero rent
            if (distance <= rent) {
                break;  // found it
            }
            if (noder == address(0x0)) {
                // no more parent, commission lost and no cut back
                emit CommissionLost(payer, miner, amount);
                return;
            }
            distance -= rent;   // safe
            noder = node.pickParent(seed);
        }

        // reuse amount for actual rewarded amount
        (amount,) = _payByBrand(memoHash, payer, noder, amount);
        emit CommissionPaid(payer, miner, noder, amount);

        // skip self cut-back
        if (noder == miner) {
            return;
        }

        Node storage node = nodes[noder];

        uint cutbackRate = node.cutbackRate;
        bool cbt = cutbackRate > CUTBACK_RATE_UNIT;
        if (cbt) {
            // reuse amount for token cutback amount
            amount = CapMath.checkedScale(amount, node.cbtRate, 10**uint(node.cbtRateDecimals));
            if (amount > 0) {
                IERC20(node.cbtAddress).transferFrom(noder, miner, amount); // failure will revert the whole claim tx
            }
        } else {
            cutbackRate &= CUTBACK_RATE_MASK;                   // rate only use the lowest 30 bits
            // reuse amount for cutBack
            amount = CapMath.checkedScale(amount, cutbackRate, CUTBACK_RATE_UNIT);
            if (amount > 0) {
                _transfer(noder, miner, amount);
            }
        }
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
