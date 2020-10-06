// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./time.sol";

/** 
 * A token balance that being burnt overtime.
 * Represented as a burning rate (uint192) and an expiration timestamp (uint64).
 */
library BurningBalance {
    uint constant MAX_UINT64    = 0xFFFFFFFFFFFFFFFF;   // maximum uint64 value

    using BurningBalance for uint;

    function pack(uint rate, uint expiration) internal pure returns (uint) {
        return (rate << 64) | expiration;
    }

    function unpack(uint bb) internal pure returns (uint rate, uint expiration) {
        return (bb >> 64, bb & MAX_UINT64);
    }

    /**
     * revert on rate == 0
     */
    function init(uint rate, uint balance) internal view returns (uint) {
        return pack(rate, time.next(balance / rate));
    }

    function getExpiration(uint bb) internal pure returns (uint) {
        return bb & MAX_UINT64;
    }

    function getRate(uint bb) internal view returns (uint) {
        (uint rate, uint expiration) = bb.unpack();
        return time.reach(expiration) ? 0 : rate;
    }

    // remain balance = rate * time.remain(expiration)
    // @dev: can be overflown
    function getRemain(uint bb) internal view returns (uint) {
        (uint rate, uint expiration) = bb.unpack();
        return rate * time.remain(expiration); // unsafe:unexploitable
    }

    function deposit(uint bb, uint amount) internal pure returns (uint) {
        (uint rate, uint expiration) = bb.unpack();
        expiration += amount / rate;    // unsafe:unexploitable
        return pack(rate, expiration);
    }

    function withdraw(uint bb, uint amount) internal view returns (uint) {
        (uint rate, uint expiration) = bb.unpack();
        expiration = SafeMath.sub(expiration, amount / rate, "BB: expiration overflow");
        require(!time.reach(expiration), "BB: not enough balance");
        return pack(rate, expiration);
    }

    function setRate(uint bb, uint rate) internal view returns (uint) {
        return init(rate, bb.getRemain());
    }

    function setRate(uint bb, uint rate, uint amount) internal view returns (uint) {
        return init(rate, bb.getRemain() + amount);   // unsafe:unexploitable
    }

    function setExpiration(uint bb, uint expiration) internal pure returns (uint) {
        (uint rate,) = bb.unpack();
        return pack(rate, expiration);
    }
}