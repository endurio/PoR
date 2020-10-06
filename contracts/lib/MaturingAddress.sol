// SPDX-License-Identifier: MIT
pragma solidity ^0.6.2;
// solium-disable security/no-block-members

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./time.sol";

/** 
 * An address that being matured overtime.
 * Represented as an address, a duration (uint32) and an matured timestamp (uint64).
 */
library MaturingAddress {
    uint constant MAX_UINT64 = 0xFFFFFFFFFFFFFFFF;
    uint constant MAX_UINT32 = 0xFFFFFFFF;

    using MaturingAddress for bytes32;

    function pack(address adr, uint duration, uint maturedTime) internal pure returns (bytes32) {
        return bytes32(bytes20(adr)) | bytes32((duration & MAX_UINT32) << 64 | (maturedTime & MAX_UINT64));
    }

    function unpack(bytes32 packed) internal pure returns (address adr, uint duration, uint maturedTime) {
        return (address(bytes20(packed)), (uint(packed) >> 64) & MAX_UINT32, (uint(packed) & MAX_UINT64));
    }

    /**
     * @dev (maturedTime - startTime) can be overflown
     */
    function init(address adr, uint startTime, uint maturedTime) internal pure returns (bytes32) {
        return pack(adr, maturedTime - startTime, maturedTime); // unsafe
    }

    function getAddress(bytes32 packed) internal pure returns (address) {
        return address(bytes20(packed));
    }

    function getDuration(bytes32 packed) internal pure returns (uint) {
        return (uint(packed) >> 64) & MAX_UINT32;
    }

    function getMaturedTime(bytes32 packed) internal pure returns (uint) {
        return uint(packed) & MAX_UINT64;
    }

    /**
     * @dev (maturedTime - duration) can be overflown
     */
    function getStartTime(bytes32 packed) internal pure returns (uint) {
        return packed.getMaturedTime() - packed.getDuration();  // unsafe
    }

    /**
     * matured rate = ellapsed / duration
     */
    function getMaturedRate(bytes32 packed) internal view returns (uint elapsed, uint duration) {
        uint maturedTime = packed.getMaturedTime();
        if (time.reach(maturedTime)) {
            return (1, 1);  // fully matured
        }
        duration = packed.getDuration();
        elapsed = time.elapse(maturedTime - duration);
    }
}