// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * ENDR token
 */
contract ENDR is ERC20 {
    constructor() public ERC20("Endurio", "ENDR") {
    }
}
