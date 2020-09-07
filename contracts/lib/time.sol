// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;

import "./util.sol";

library time {
    function blockTimestamp() internal view returns (uint) {
        return block.timestamp;
    }

    function reach(uint timestamp) internal view returns (bool) {
        return timestamp <= blockTimestamp();
    }

    function next(uint duration) internal view returns (uint) {
        return util.addCap(blockTimestamp(), duration);
    }

    function ago(uint duration) internal view returns (uint) {
        return util.subCap(blockTimestamp(), duration);
    }

    function elapse(uint timestamp) internal view returns (uint) {
        return util.subCap(blockTimestamp(), timestamp);
    }

    function remain(uint timestamp) internal view returns (uint) {
        return util.subCap(timestamp, blockTimestamp());
    }
}