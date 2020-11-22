pragma solidity ^0.6.2;

library util {
    function abs(int a) internal pure returns (uint) {
        return uint(a > 0 ? a : -a);
    }

    // subtract 2 uints and convert result to int
    function sub(uint a, uint b) internal pure returns(int) {
        // require(|a-b| < 2**128)
        return a > b ? int(a - b) : -int(b - a);
    }

    // TODO: apply SafeMath
    function add(uint a, int b) internal pure returns(uint) {
        if (b < 0) {
            return a - uint(-b);
        }
        return a + uint(b);
    }

    function inOrder(uint a, uint b, uint c) internal pure returns (bool) {
        return (a <= b && b <= c) || (a >= b && b >= c);
    }

    function inStrictOrder(uint a, uint b, uint c) internal pure returns (bool) {
        return (a < b && b < c) || (a > b && b > c);
    }

    function inOrder(int a, int b, int c) internal pure returns (bool) {
        return (a <= b && b <= c) || (a >= b && b >= c);
    }

    function inStrictOrder(int a, int b, int c) internal pure returns (bool) {
        return (a < b && b < c) || (a > b && b > c);
    }

    function max(uint192 a, uint192 b) internal pure returns (uint192) {
        return a >= b ? a : b;
    }

    function min(uint192 a, uint192 b) internal pure returns (uint192) {
        return a <= b ? a : b;
    }

    /**
     * Return index of most significant non-zero bit in given non-zero 256-bit
     * unsigned integer value.
     *
     * @param x value to get index of most significant non-zero bit in
     * @return r - index of most significant non-zero bit in given number
     */
    // solium-disable-next-line security/no-assign-params
    function mostSignificantBit (uint256 x) internal pure returns (uint8 r) {
        require (x > 0, "must be positive");

        if (x >= 0x100000000000000000000000000000000) {x >>= 128; r += 128;}
        if (x >= 0x10000000000000000) {x >>= 64; r += 64;}
        if (x >= 0x100000000) {x >>= 32; r += 32;}
        if (x >= 0x10000) {x >>= 16; r += 16;}
        if (x >= 0x100) {x >>= 8; r += 8;}
        if (x >= 0x10) {x >>= 4; r += 4;}
        if (x >= 0x4) {x >>= 2; r += 2;}
        if (x >= 0x2) r += 1; // No need to shift x anymore
    }
}

library Packed {
    function ui32(bytes32 packed, uint bitOffset) internal pure returns (uint32) {
        return uint32(extract(packed, bitOffset, (1<<32)-1));
    }

    function flag(bytes32 packed, uint bitOffset) internal pure returns (bool) {
        return extract(packed, bitOffset, 1) == 1;
    }

    function extract(bytes32 packed, uint bitOffset, uint bitMask) internal pure returns (uint) {
        return (uint(packed) >> bitOffset) & bitMask;
    }
}
