// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

import {util} from "./lib/util.sol";
import {RefNetwork} from "./RefNetwork.sol";

/**
 * Market for brands to bid for miner.
 */
contract BrandMarket is RefNetwork {
    bytes constant ENDURIO = "endur.io";

    mapping(bytes32 => Brand) internal brands; // keccak(brand.memo) => Brand

    struct Brand {
        address owner;
        uint rate;    // 18 decimals
        bytes memo;
    }

    constructor() public RefNetwork() {
        brands[keccak256(ENDURIO)] = Brand({
            owner: address(this),
            rate: 1e18,
            memo: ENDURIO
        });
    }
}
