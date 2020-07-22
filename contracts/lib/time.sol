// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;

library time {
    function blockTimestamp() internal view returns (uint) {
        return block.timestamp;
    }
}