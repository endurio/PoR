// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

import "./time.sol";

struct TAddress {
    bytes32 current;    // address(20) + maturedTime(12 bytes)
    bytes32 previous;   // address(20) + maturedTime(12 bytes)
}

/**
 * Transferable Address - an address that can be transfered but will take effect gradually.
 *
 * Transfering address require the a duration for the transfer to be matured.
 * The transfer effect will be gradually happend in the course of maturing time.
 *
 * @dev address and maturedTime is packed into an bytes32 to optimize for storage access.
 */
library tadr {
    using tadr for TAddress;

    uint96 public constant MAX_UINT96 = 0xFFFFFFFFFFFFFFFFFFFFFFFF;

    function exists(TAddress storage ta) internal view returns (bool) {
        return ta.current != 0;
    }

    /**
     * Split the logic of extract and maturingRate out for optimization.
     *
     * (address a, uint96 mtime) = ta.extract();
     * if (block.timestamp < mtime) { // unmatured
     *    (uint dividend, uint divisor, address pA) = ta.maturingRate(mtime);
     *    // handle maturing address here
     * } else {
     *    // handle matured address here
     * }
     */
    function extract(TAddress storage ta) internal view returns (address, uint96) {
        bytes32 current = ta.current;
        return (address(bytes20(current)), uint96(uint(current)));
    }

    function extractPrevious(TAddress storage ta) internal view returns (address, uint96) {
        bytes32 previous = ta.previous;
        return (address(bytes20(previous)), uint96(uint(previous)));
    }

    /**
     * Split the logic of extract and maturingRate out for optimization.
     * This function is only called when block.timestamp < currentMTime (a.k.a unmatured)
     */
    function maturingRate(TAddress storage ta, uint currentMTime)
        internal view
        returns (uint dividend, uint divisor, address prevAddress)
    {
        uint prevMTime;
        (prevAddress, prevMTime) = ta.extractPrevious();
        divisor = (currentMTime - prevMTime) / 2;
        dividend = divisor - time.remain(currentMTime);
    }

    // TODO: handle revert to matured address
    function transferTo(TAddress storage ta, address _value) internal {
        bytes32 current = ta.current;
        if (current == 0) { // uninitialized
            forceTo(ta, _value, uint96(time.blockTimestamp()));
            return;
        }
        // address currentValue = address(bytes20(current));
        uint currentMTime = uint96(uint(current));
        if (!time.reach(currentMTime)) { // not matured
            bytes32 prev = ta.previous;
            // address previousValue = address(bytes20(previous));
            currentMTime = uint96(uint(prev)); // use the prevMTime as currentMTime
            // assert(currentMTime <= currentMTime);
        } else { // matured
            ta.previous = current;
        }
        // calculate the future matured time for the new value
        uint elapsed = time.elapse(currentMTime);
        currentMTime = time.next(elapsed);
        // incomming paranoid check
        if (currentMTime > MAX_UINT96 || currentMTime < time.blockTimestamp()) { // overflown
            currentMTime = MAX_UINT96; // cap the result
        }
        ta.current = bytes32((uint(_value) << 96) | uint96(currentMTime));
    }

    /**
     * forcefully change the value to new address without changing any other fields
     */
    function forceTo(TAddress storage ta, address _value) internal {
        forceTo(ta, _value, uint96(uint(ta.current)));
    }

    /**
     * forcefully change both the current value and matureTime
     */
    function forceTo(TAddress storage ta, address _value, uint96 currentMTime) internal {
        ta.current = bytes32((uint(_value) << 96) | currentMTime);
    }
}