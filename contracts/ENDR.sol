// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * ENDR token
 */
contract ENDR is ERC20 {
    constructor() public ERC20("Endurio", "ENDR") {
    }

    /**
     * Extra function to attach a message to a transfer
     *
     * Requirements:
     * - `recipient` cannot be the zero address.
     * - the caller must have a balance of at least `amount`.
     */
    function transfer(address recipient, uint256 amount, bytes calldata) external returns (bool) {
        _transfer(_msgSender(), recipient, amount);
        return true;
    }
}
