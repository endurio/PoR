// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-inline-assembly

import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";
import {BTCUtils} from "./lib/bitcoin-spv/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "./lib/bitcoin-spv/contracts/CheckBitcoinSigs.sol";
import {ValidateSPV} from "./lib/bitcoin-spv/contracts/ValidateSPV.sol";
import "./lib/util.sol";
import "./DataStructure.sol";

/**
 * Upgradable Proxy with 3 implementation contracts for: PoR, BrandMarket and RefNetwork
 *
 * @dev proxy class can't have any (structured) state variable, all state is located in DataStructure
 */
contract Proxy is DataStructure {
    /**
     * @dev Emitted when the implementation is changed.
     * @param signature 4-bytes function signature.
     * @param implementation Address of the new implementation.
     */
    event Implementation(bytes32 indexed signature, address indexed implementation);

    constructor(
        address implERC20,
        address implBrandMarket,
        address implRefNet,
        address implPoR
    ) public {
        owner = msg.sender; // responsible for contract upgrade
        // TODO: write a script to auto-generate this map
        impls[0xbe45fd62] = implERC20;          // ENDR.transfer
        impls[0x06fdde03] = implERC20;          // name
        impls[0x95d89b41] = implERC20;          // symbol
        impls[0x313ce567] = implERC20;          // decimals
        impls[0x18160ddd] = implERC20;          // totalSupply
        impls[0x70a08231] = implERC20;          // balanceOf
        impls[0xa9059cbb] = implERC20;          // transfer
        impls[0xdd62ed3e] = implERC20;          // allowance
        impls[0x095ea7b3] = implERC20;          // approve
        impls[0x23b872dd] = implERC20;          // transferFrom
        impls[0x39509351] = implERC20;          // increaseAllowance
        impls[0xa457c2d7] = implERC20;          // decreaseAllowance
        impls[0x7d484b78] = implBrandMarket;    // registerBrand
        impls[0xbeba8022] = implBrandMarket;    // activate
        impls[0x22eee84c] = implBrandMarket;    // deactivate
        impls[0x8e19899e] = implBrandMarket;    // withdraw
        impls[0xc0af347a] = implBrandMarket;    // depositToBrand
        impls[0x491d1d00] = implBrandMarket;    // depositToBrand
        impls[0x59f78a47] = implPoR;            // mine
        impls[0xa740a4ac] = implPoR;            // commitTx
        impls[0xd02898cf] = implPoR;            // commitBlock
        impls[0x495dd54b] = implPoR;            // registerMiner
        impls[0x0aa0738f] = implPoR;            // changeMiner
        impls[0x7a0ca1e2] = implRefNet;         // attach
        impls[0x75d3e9d4] = implRefNet;         // commitChain
        impls[0x369e8c1d] = implRefNet;         // commit
    }

    /**
     * set the implementation contract for a single function signature.
     */
    function setImplementation(bytes32 sign, address impl) external {
        require(msg.sender == owner, "owner only");
        // TODO: verify impl is a contract
        _setImplementation(sign, impl);
    }

    /**
     * set implementation contract for multiple function signatures,
     * packed in the signs from the left.
     */
    function setImplementations(bytes32 signs, address impl) external {
        require(msg.sender == owner, "owner only");
        // TODO: verify impl is a contract
        bytes32 ss = signs;
        for (uint i = 0; i < 8; ++i) {
            bytes4 sign = bytes4(ss);
            if (sign == 0) {
                return;
            }
            _setImplementation(sign, impl);
            ss <<= 32;
        }
    }

    function _setImplementation(bytes32 sign, address impl) internal {
        impls[bytes4(sign)] = impl;
        emit Implementation(sign, impl);
    }

    function changeOwner(address newOwner) external {
        require(msg.sender == owner, "owner only");
        owner = newOwner;
    }

    /**
     * @dev fallback implementation.
     * Extracted to enable manual triggering.
     */
    fallback() external payable {
        _delegate(_implementation());
    }

    /**
     * @dev Returns the current implementation.
     * @return Address of the current implementation
     */
    function _implementation() internal view returns (address) {
        address impl = impls[msg.sig];
        require(impl != address(0x0), "function not exist");
        return impl;
    }

    /**
     * @dev Delegates execution to an implementation contract.
     * This is a low level function that doesn't return to its internal call site.
     * It will return to the external caller whatever the implementation returns.
     * @param implementation Address to delegate.
     */
    function _delegate(address implementation) internal {
        assembly {
            // Copy msg.data. We take full control of memory in this inline assembly
            // block because it will not return to Solidity code. We overwrite the
            // Solidity scratch pad at memory position 0.
            calldatacopy(0, 0, calldatasize())

            // Call the implementation.
            // out and outsize are 0 because we don't know the size yet.
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)

            let size := returndatasize()
            // Copy the returned data.
            returndatacopy(0, 0, size)

            switch result
            // delegatecall returns 0 on error.
            case 0 { revert(0, size) }
            default { return(0, size) }
        }
    }
}
