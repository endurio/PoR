// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

// solium-disable security/no-inline-assembly

import "./DataStructure.sol";

/**
 * ENDR is an ERC20 and an Upgradable Proxy with 3 implementation contracts: PoR, BrandMarket and RefNetwork
 *
 * @dev proxy class can't have any (structured) state variable, all state is located in DataStructure
 */
contract ENDR is DataStructure {
    /**
     * @dev Emitted when the implementation is changed.
     * @param signature 4-bytes function signature.
     * @param implementation Address of the new implementation.
     */
    event Implementation(bytes32 indexed signature, address indexed implementation);

    constructor(
        // address implERC20,
        address implBrandMarket,
        address implRefNetwork,
        address implPoR
    ) public {
        owner = msg.sender; // responsible for contract upgrade

        // delegate call initialize() for each implementations
        mustDelegateCall(implBrandMarket, hex"8129fc1c");
        mustDelegateCall(implRefNetwork, hex"8129fc1c");

        // All ERC20 functions are not upgradable
        // impls[0xbe45fd62] = implERC20;          // ENDR.transfer
        // impls[0x06fdde03] = implERC20;          // name
        // impls[0x95d89b41] = implERC20;          // symbol
        // impls[0x313ce567] = implERC20;          // decimals
        // impls[0x18160ddd] = implERC20;          // totalSupply
        // impls[0x70a08231] = implERC20;          // balanceOf
        // impls[0xa9059cbb] = implERC20;          // transfer
        // impls[0xdd62ed3e] = implERC20;          // allowance
        // impls[0x095ea7b3] = implERC20;          // approve
        // impls[0x23b872dd] = implERC20;          // transferFrom
        // impls[0x39509351] = implERC20;          // increaseAllowance
        // impls[0xa457c2d7] = implERC20;          // decreaseAllowance

        // generator script: change the contract name in export part
        // (export CONTRACT=BrandMarket; cat ./build/contracts/$CONTRACT.json | sed -ne '/"legacyAST": {/,$p' | grep -A7 functionSelector | grep 'functionSelector\|"name": "' | sed 's/[",]//g' | sed 's/.*: //g' | sed 'N;s/\n/ /' | awk '{print "impls[0x"$0}' | sed "s/ /] = impl$CONTRACT;\t\/\/ /g")
        impls[0x231ab4bd] = implBrandMarket;    // register
        impls[0xbeba8022] = implBrandMarket;    // activate
        impls[0x22eee84c] = implBrandMarket;    // deactivate
        impls[0x8e19899e] = implBrandMarket;    // withdraw
        impls[0x1de26e16] = implBrandMarket;    // deposit
        impls[0xd954863c] = implBrandMarket;    // deposit
        impls[0x84cc9dfb] = implPoR;    // claim
        impls[0x94457260] = implPoR;    // claimWithPrevTx
        impls[0x60b5fe2a] = implPoR;    // commitTx
        impls[0xd02898cf] = implPoR;    // commitBlock
        impls[0x495dd54b] = implPoR;    // registerMiner
        impls[0x0aa0738f] = implPoR;    // changeMiner
        impls[0x5ca1e165] = implRefNetwork;     // getRoot
        impls[0x003ba1ed] = implRefNetwork;     // setRoot
        impls[0x7a0ca1e2] = implRefNetwork;     // attach
        impls[0xb6b55f25] = implRefNetwork;     // deposit
        impls[0x2e1a7d4d] = implRefNetwork;     // withdraw
        impls[0xb12a6852] = implRefNetwork;     // setRent
        impls[0xe0719564] = implRefNetwork;     // getRent
        impls[0x7dd55a78] = implRefNetwork;     // flatten
        impls[0xa8074c98] = implRefNetwork;     // payChain
        impls[0x0c11dedd] = implRefNetwork;     // pay
    }

    function mustDelegateCall(address impl, bytes memory data) internal {
        (bool ok,) = impl.delegatecall(data);
        if (!ok) {
            assembly {
                let size := returndatasize()
                returndatacopy(0, 0, size)
                revert(0, size)
            }
        }
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

    function getOwner() external view returns (address) {
        return owner;
    }

    function setOwner(address newOwner) external {
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
