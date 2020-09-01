// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

import "./util.sol";
import "./time.sol";

struct SUint192 {
    bytes32 scheduledData; // scheduledTime(8 bytes) + scheduledValue (24 bytes)
    uint192 committedValue;
}

/**
 * Scheduled Value - a value that can be scheduled to change next a delay.
 */
library suint192 {
    using suint192 for SUint192;

    function scheduled(SUint192 storage sv) internal view returns (uint192) {
        return uint192(uint256(sv.scheduledData));
    }

    function committed(SUint192 storage sv) internal view returns (uint192) {
        (uint192 _scheduled, bool _matured) = sv._firstSLOAD();
        if (_matured) return _scheduled;
        return sv.committedValue; // second SLOAD
    }

    function max(SUint192 storage sv) internal view returns (uint192) {
        (uint192 _scheduled, bool _matured) = sv._firstSLOAD();
        if (_matured) return _scheduled;
        return util.max(_scheduled, sv.committedValue);
    }

    function min(SUint192 storage sv) internal view returns (uint192) {
        (uint192 _scheduled, bool _matured) = sv._firstSLOAD();
        if (_matured) return _scheduled;
        return util.min(_scheduled, sv.committedValue);
    }

    function isScheduling(SUint192 storage sv) internal view returns (bool) {
        return !time.reach(uint64(bytes8(sv.scheduledData)));
    }

    // @unsafe: (block.timestamp + delay) can overflow uint64
    function schedule(SUint192 storage sv, uint value, uint delay) internal {
        bytes32 scheduledData = sv.scheduledData;                           // SLOAD
        if (time.reach(uint64(bytes8(scheduledData)))) {
            // commit the matured scheduling value
            sv.committedValue = uint192(uint256(scheduledData));             // SSTORE
        }
        // init or re-new the scheduled time with new value
        uint64 scheduledTime = uint64(time.next(delay));
        sv.scheduledData = bytes32(value | (scheduledTime << 192));   // SSTORE
    }

    // directly commit the value
    function commit(SUint192 storage sv, uint value) internal {
        sv.scheduledData = bytes32(value); // scheduledTime = 0
    }

    function _firstSLOAD(SUint192 storage sv) internal view returns (uint192 _scheduled, bool _matured) {
        bytes32 scheduledData = sv.scheduledData;   // SLOAD
        _scheduled = uint192(uint256(scheduledData));
        _matured = time.reach(uint64(bytes8(scheduledData)));
    }
}