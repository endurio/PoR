// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

struct SUint192 {
    bytes32 scheduledData; // scheduledTime(8 bytes) + scheduledValue (24 bytes)
    uint192 commitedValue;
}

/**
 * Scheduled Value - a value that can be scheduled to change after a delay.
 */
library suint192 {
    function commited(SUint192 storage sv) internal view returns (uint192) {
        bytes32 scheduledData = sv.scheduledData;   // SLOAD
        if (uint64(bytes8(scheduledData)) <= block.timestamp) {
            return uint192(uint256(scheduledData));
        }
        return sv.commitedValue;                    // SLOAD
    }

    function scheduled(SUint192 storage sv) internal view returns (uint192) {
        return uint192(uint256(sv.scheduledData));
    }

    function isScheduling(SUint192 storage sv) internal view returns (bool) {
        return block.timestamp < uint64(bytes8(sv.scheduledData));
    }

    // @unsafe: (block.timestamp + delay) can overflow uint64
    function schedule(SUint192 storage sv, uint192 value, uint delay) internal {
        bytes32 scheduledData = sv.scheduledData;                           // SLOAD
        if (uint64(bytes8(scheduledData)) <= block.timestamp) {
            // commit the scheduled value that reached scheduled time
            sv.commitedValue = uint192(uint256(scheduledData));             // SSTORE
        }
        uint64 scheduledTime = uint64(block.timestamp + delay);
        sv.scheduledData = bytes32(uint(value) | (scheduledTime << 192));   // SSTORE
    }

    // directly commit the value
    function commit(SUint192 storage sv, uint192 value) internal {
        sv.scheduledData = bytes32(uint(value)); // scheduledTime = 0
    }
}