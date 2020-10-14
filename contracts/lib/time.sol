// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;

import "./CapMath.sol";

library time {
    function blockTimestamp() internal view returns (uint) {
        return block.timestamp;
    }

    function reach(uint timestamp) internal view returns (bool) {
        return timestamp <= blockTimestamp();
    }

    function next(uint duration) internal view returns (uint) {
        return CapMath.add(blockTimestamp(), duration);
    }

    function ago(uint duration) internal view returns (uint) {
        return CapMath.sub(blockTimestamp(), duration);
    }

    function elapse(uint timestamp) internal view returns (uint) {
        return CapMath.sub(blockTimestamp(), timestamp);
    }

    function remain(uint timestamp) internal view returns (uint) {
        return CapMath.sub(timestamp, blockTimestamp());
    }
}