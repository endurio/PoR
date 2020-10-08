// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

interface IRefNet {
    /**
     * @return ok - whether the resource for this reward could be cleaned up
     */
    function reward(
        address miner,
        address payer,
        uint amount,
        bytes32 memoHash,
        bytes32 seed        // this value will be hashed against memoHash to create an random number
    ) external returns (bool ok);
}
