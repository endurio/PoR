// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

interface ICommissionReceiver {
    function pay(
        address miner,
        address payer,
        uint amount
    ) external returns (uint cutBackCommission);
}
