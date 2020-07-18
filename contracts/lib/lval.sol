// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

import "@openzeppelin/contracts/math/SafeMath.sol";

struct LUint {
    uint value;     // value in the lastTouch;
    uint rate;      // leaking rate = value / sec
    uint lastTouch; // last time the value is changed
}

/**
 * Leaking Value - a value that reducing over time with a constant rate.
 */
library lval {
    /**
     * peek the current value without modify the storage
     */
    function peek(LUint storage lv) internal view returns (uint) {
        // assert: lastTouch <= block.timestamp
        uint value = lv.value;
        if (value == 0) {
            return 0;
        }
        uint rate = lv.rate;
        if (rate == 0) {
            return value;
        }
        uint elapsed = block.timestamp - lv.lastTouch;
        // if (elapsed == 0) {
        //     return value;
        // }
        uint leaked = rate * elapsed; // unsafe
        if (value <= leaked || leaked / rate != elapsed) { // overleaked or overflown
            return 0; // all value has been leaked for a while
        }
        return value - leaked;
    }

    /**
     * @return leakingRate or zero if the balance is zero
     *
     * TODO: optimize this: check lv.rate == 0 first (?)
     */
    function getEffectiveLeakingRate(LUint storage lv) internal view returns (uint) {
        return peek(lv) > 0 ? lv.rate : 0;
    }

    /**
     * get the current value and update the storage if nessesary
     */
    function poll(LUint storage lv) internal returns (uint) {
        uint value = peek(lv);
        if (lv.value != value) {
            lv.value = value;
            lv.lastTouch = block.timestamp;
        }
        return value;
    }

    function inc(LUint storage lv, uint value) internal {
        lv.value = SafeMath.add(peek(lv), value);
        lv.lastTouch = block.timestamp;
    }

    function dec(LUint storage lv, uint value) internal {
        lv.value = SafeMath.sub(peek(lv), value, "LeakingValue: decrement overflow");
        lv.lastTouch = block.timestamp;
    }

    function setLeakingRate(LUint storage lv, uint rate) internal {
        poll(lv);
        lv.rate = rate;
    }

    // raw value, disregard of leaking rate
    function rawValue(LUint storage lv) internal view returns (uint) {
        return lv.value;
    }

    // raw increment, disregard of leaking rate
    function rawInc(LUint storage lv, uint value) internal {
        lv.value = SafeMath.add(lv.value, value);
    }

    // raw decrement, disregard of leaking rate
    function rawDec(LUint storage lv, uint value) internal {
        lv.value = SafeMath.sub(lv.value, value, "LeakingValue: raw decrement overflow");
    }
}