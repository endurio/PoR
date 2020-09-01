// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./suint192.sol";
import "./time.sol";

struct Balance {
    uint        value;      // value in the lastTouch;
    SUint192    rate;       // rate = value / sec
    uint        lastTouch;  // last time the value is changed
}

/** 
 * Renting Balance - a balance that reducing over time with a renting rate.
 */
library rb {
    uint constant RENT_DELAY = 1 weeks;

    using rb for Balance;
    using suint192 for SUint192;

    /**
     * peek the current value without modify the storage
     */
    function peek(Balance storage b) internal view returns (uint) {
        // assert: time.reach(lastTouch)
        uint value = b.value;
        if (value == 0) {
            return 0;
        }
        uint rate = b.rate.scheduled(); // using future rate since the rent has to be paid upfront
        if (rate == 0) {
            return value;
        }
        uint elapsed = time.elapse(b.lastTouch);
        // if (elapsed == 0) {
        //     return value;
        // }
        uint rent = rate * elapsed; // unsafe
        if (value <= rent || rent / rate != elapsed) { // overleaked or overflown
            return 0; // all value has been rent for a while
        }
        return value - rent;
    }

    /**
     * get the current value and update the storage if nessesary
     */
    function poll(Balance storage b) internal returns (uint) {
        uint value = peek(b);
        if (b.value != value) {
            b.value = value;
            b.lastTouch = time.blockTimestamp();
        }
        return value;
    }

    function add(Balance storage b, uint value) internal {
        b.value = SafeMath.add(peek(b), value);
        b.lastTouch = time.blockTimestamp();
    }

    function sub(Balance storage b, uint value) internal {
        b.value = SafeMath.sub(peek(b), value, "RentingBalance: subtraction overflow");
        b.lastTouch = time.blockTimestamp();
    }

    function setRate(Balance storage b, uint rate) internal {
        poll(b);
        b.rate.schedule(rate, RENT_DELAY);
    }

    function getRate(Balance storage b) internal view returns (uint) {
        return b.rate.scheduled();
    }

    /**
     * @return renting rate or zero if the balance is zero
     *
     * TODO: optimize this: check b.rate == 0 first (?)
     */
    function getWeight(Balance storage b) internal view returns (uint) {
        return peek(b) > 0 ? b.rate.committed() : 0; // using committed rate for delay effect
    }

    // raw increment, disregard of leaking rate
    function rawAdd(Balance storage b, uint value) internal {
        b.value = SafeMath.add(b.value, value);
    }

    // raw decrement, disregard of leaking rate
    function rawSub(Balance storage b, uint value) internal {
        b.value = SafeMath.sub(b.value, value, "RentingBalance: raw subtraction overflow");
    }
}