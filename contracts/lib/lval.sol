// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;

import "@openzeppelin/contracts/math/SafeMath.sol";

// solium-disable security/no-block-members

/**
 * Leaking Value - a value that reducing over time with a constant rate.
 */
library lval {
    struct LUint {
        uint value;     // value in the lastTouch;
        uint rate;      // leaking rate = value / sec
        uint lastTouch; // last time the value is changed
    }

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
}