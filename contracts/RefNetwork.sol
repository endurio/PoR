// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

/** @title RefNetwork */
/** @author Zergity (https://endur.io) */

// solium-disable security/no-block-members

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./Token.sol";
import "./lib/CapMath.sol";
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
contract RefNetwork is DataStructure, Token, IRefNet {
    using libnode for Node;
    using ABDKMath64x64 for int128;

    uint    constant MAX_UINT192        = (1<<192)-1;
    uint    constant MAX_UINT64         = (1<<64)-1;

    uint    constant ROOT_COM_RATE      = 32;       // root commission chance = 1/32
    uint    constant RENT_EPOCH         = 1 weeks;

    /**
     * init a node, attach or re-attach to parent node
     */
    function attach(address parent) external {
        nodes[msg.sender].attach(parent);

        while (parent != address(0x0)) {
            require(parent != msg.sender, "circular reference");
            parent = nodes[parent].parent;
        }
    }

    function update(int fund, uint newRent, bool escalate) external returns (uint rent, uint expiration, uint fee) {
        require(newRent <= MAX_UINT192, "newRent overflow ui192");

        Node storage node = nodes[msg.sender];
        (rent, expiration) = (node.rent, node.expiration);      // SLOAD

        uint balance = time.remain(expiration) * rent;
        if (fund > 0) {
            uint amount = uint(fund);
            _burn(msg.sender, amount);
            balance = SafeMath.add(balance, amount);
        } else if (fund < 0) {
            require(balance > 0, "!balance");
            uint amount = uint(-fund);
            if (balance < amount) {
                // empty the node balance
                amount = balance;
            }
            _mint(msg.sender, amount);
            balance -= amount;   // safe
        } else /* fund == 0 */ {
            require(newRent > 0, "noop");
        }

        if (newRent == 0) {
            newRent = rent; // rent unchanged
        }

        if (expiration > 0) {
            // initialized
            uint elapsed = time.elapse(expiration);
            if (elapsed > 0) {
                // expired and decaying
                rent = _getDecayingRent(rent, elapsed);
            }
        }

        if (newRent != rent) {
            // rent changed
            if (newRent > rent) {
                // upgrade
                fee = SafeMath.mul(newRent-rent, RENT_EPOCH/2); // safe
                if (newRent > rent*2 || !time.reach(node.cooldownEnd)) {
                    require(escalate, "!escalate");
                    fee = SafeMath.mul(fee, 3);
                }
                balance = SafeMath.sub(balance, fee, "balance < upgrade fee");
                node.cooldownEnd = uint64(time.next(RENT_EPOCH));   // schedule the next slow upgrade
            }
            rent = newRent;
        }

        require(rent > 0, "!rent");
        expiration = time.next(balance / rent);
        // discard posible remainder of balance % rent

        require(expiration <= MAX_UINT64, "expiration overflow ui64");

        (node.rent, node.expiration) = (uint192(rent), uint64(expiration));  // SSTORE
    }

    function query(address noder) external view returns (
        address parent,
        uint    rent,
        uint    expiration,
        uint    balance,
        uint    decayingRent,
        uint    cooldownEnd,
        uint    cutbackRate,
        address cbtAddress,
        uint    cbtRateDecimals,
        uint    cbtRate
    ) {
        Node storage node = nodes[noder];
        parent = node.parent;
        rent = node.rent;
        expiration = node.expiration;
        balance = rent * time.remain(expiration);
        decayingRent = rent;
        if (expiration > 0) {
            // initialized
            uint elapsed = time.elapse(expiration);
            if (elapsed > 0) {
                // expired and decaying
                decayingRent = _getDecayingRent(rent, elapsed);    
            }
        }
        cooldownEnd = node.cooldownEnd;
        cutbackRate = node.cutbackRate;
        cbtAddress = node.cbtAddress;
        cbtRateDecimals = node.cbtRateDecimals;
        cbtRate = node.cbtRate;
    }

    /// decayinRent = (rent/2**(elapsed/CD))*(1-elapsed%CD/CD/2)
    function _getDecayingRent(uint rent, uint elapsed) internal pure returns (uint) {
        // exponential decay over weeks
        rent >>= elapsed/RENT_EPOCH;
        // linear decay from 1 to 0.5 during the week
        uint weekDecaying = CapMath.checkedScale(rent, elapsed%RENT_EPOCH, RENT_EPOCH*2);
        return SafeMath.sub(rent, weekDecaying, "decaying rent overflow");
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

    function reward(
        address miner,
        address payer,
        uint amount,
        bytes32 memoHash,
        bytes32 blockHash,
        bool skipCommission
    ) external override {
        require(msg.sender == address(this), "!internal");  // must be called from other implemenetation

        {
            (uint rewarded, bool empty) = _payByBrand(memoHash, payer, miner, amount);
            emit Claim(blockHash, memoHash, miner, payer, rewarded);
            if (empty) {
                return;  // brand has no more fund to pay for commission
            }
        }

        uint uiSeed = uint(keccak256(abi.encodePacked(memoHash, blockHash)));

        // there's always 1/32 chance that the raw commission will go to root
        if (uiSeed % ROOT_COM_RATE == 0) {
            (uint rootCom,) = _payByBrand(memoHash, payer, config.root, amount);
            emit CommissionRoot(payer, miner, rootCom);
            return;
        }

        if (skipCommission) {
            emit CommissionSkip(payer, miner, amount);
            return;
        }

        uint commission = CapMath.checkedScale(amount, config.comRate, COM_RATE_UNIT);
        if (commission > 0) {
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
        uint distance = x.log_2().neg().muluc(config.rentScale);

        address noder = miner;
        while(true) {
            Node storage node = nodes[noder];
            uint rent = node.getRent();
            // short-circuit for zero rent
            if (distance < rent) {
                break;  // found it
            }
            if (noder == address(0x0)) {
                // no more parent, commission lost and no cut back
                emit CommissionLost(payer, miner, amount);
                return;
            }
            distance -= rent;   // safe
            noder = node.parent;
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
    function attach(Node storage n, address parent) internal {
        n.parent = parent;
    }

    // a node's weight
    function getRent(Node storage n) internal view returns (uint) {
        uint expiration = n.expiration;
        if (time.reach(expiration)) {
            return 0;
        }
        return n.rent;
    }
}
