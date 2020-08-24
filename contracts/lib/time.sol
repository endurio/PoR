// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;

library time {
    function blockTimestamp() internal view returns (uint) {
        return block.timestamp;
    }

    function reach(uint timestamp) internal view returns (bool) {
        return timestamp <= blockTimestamp();
    }

    // @unsafe
    function next(uint delay) internal view returns (uint) {
        return blockTimestamp() + delay;
    }

    // @unsafe
    function ago(uint delay) internal view returns (uint) {
        return blockTimestamp() - delay;
    }

    // @unsafe
    function elapse(uint timestamp) internal view returns (uint) {
        return blockTimestamp() - timestamp;
    }

    // @unsafe
    function remain(uint timestamp) internal view returns (uint) {
        return timestamp - blockTimestamp();
    }
}