// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

struct SUint {
    uint commitedValue;
    uint scheduledValue;
    uint scheduledTime;
}

/**
 * Scheduled Value - a value that can be scheduled to change after a delay.
 *
 * TODO: optimize for 28 bytes value.
 */
library sval {

    function commited(SUint storage sv) internal view returns (uint) {
        return sv.scheduledTime <= block.timestamp ? sv.scheduledValue : sv.commitedValue;
    }

    function scheduled(SUint storage sv) internal view returns (uint) {
        return sv.scheduledValue;
    }

    function isScheduling(SUint storage sv) internal view returns (bool) {
        return block.timestamp < sv.scheduledTime;
    }

    // @unsafe: (block.timestamp + delay) can be overflown
    function schedule(SUint storage sv, uint value, uint delay) internal {
        if (sv.scheduledTime <= block.timestamp) {
            // save the commited value to commitedValue
            sv.commitedValue = sv.scheduledValue;
        }
        sv.scheduledValue = value;
        sv.scheduledTime = block.timestamp + delay; // unsafe
    }

    // directly commit the value
    function commit(SUint storage sv, uint value) internal {
        sv.scheduledValue = value;
        if (block.timestamp < sv.scheduledTime) {
            sv.scheduledTime = block.timestamp; // more consistent gas usage than zeroing the storage here
        }
    }
}