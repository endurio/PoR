// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

/** @title IRefNet */
/** @author Zergity (https://endur.io) */

interface IRefNet {
    function reward(
        bytes32 blockHash,    // this value will be hashed against memoHash to create an random number
        bytes32 memoHash,
        address miner,
        address payer,
        uint    amount,
        address submitter,
        uint    submitFee,
        bool    skipCommission
    ) external;
}
