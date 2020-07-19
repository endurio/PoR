pragma solidity ^0.6.2;

library util {
    uint256 constant MAX_UINT256 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    int256  constant MAX_INT256  = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    int256  constant MIN_INT256  = MAX_INT256 + 1;

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

    /**
     * @dev assert(a <= b)
     * @return x * b / c (precision can be lower if (x*b) overflown)
     */
    // solium-disable-next-line security/no-assign-params
    function scaleDown(uint x, uint a, uint b) internal pure returns (uint) {
        // assert(a < b);
        if (a == 0) {
            return 0;
        }

        uint y = x * a;
        if (y / a == x) {
            return y / b;
        }

        uint shifted = 0;
        do {
            x >>= 1;
            ++shifted;
            y = x * a;
        } while(y / a != x);

        return (y / b) << shifted; // a <= b so this <= x (can't be overflown)
    }

    // capped addition
    // if the calculation is overflown, return the max or min value of the type
    function addCap(uint a, uint b) internal pure returns (uint) {
        uint256 c = a + b;
        if (c >= a) {
            return c;
        }
        // addition overflow
        return MAX_UINT256;
    }

    // capped multiply
    // if the calculation is overflown, return the max or min value of the type
    function mulCap(int a, int b) internal pure returns (int) {
        // Gas optimization: this is cheaper than requiring 'a' not being zero, but the
        // benefit is lost if 'b' is also tested.
        // See: https://github.com/OpenZeppelin/openzeppelin-solidity/pull/522
        if (a == 0) {
            return 0;
        }

        int c = a * b;
        if (c / a == b) {
            return c;
        }

        if (inStrictOrder(a, 0, b)) {
            // negative overflown
            return MIN_INT256;
        }
        // positive overflown
        return MAX_INT256;
    }

    // unsigned capped multiply
    // if the calculation is overflown, return the max value of uint256
    function mulCap(uint a, uint b) internal pure returns (uint) {
        // Gas optimization: this is cheaper than requiring 'a' not being zero, but the
        // benefit is lost if 'b' is also tested.
        // See: https://github.com/OpenZeppelin/openzeppelin-solidity/pull/522
        if (a == 0) {
            return 0;
        }

        uint c = a * b;
        if (c / a == b) {
            return c;
        }

        // overflown
        return MAX_UINT256;
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