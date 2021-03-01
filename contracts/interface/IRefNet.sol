// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

/** @title IRefNet */
/** @author Zergity (https://endur.io) */

interface IRefNet {
    function reward(
        address miner,
        address payer,
        uint amount,
        bytes32 memoHash,
        bytes32 blockHash,  // this value will be hashed against memoHash to create an random number
        bool skipCommission
    ) external;
}
