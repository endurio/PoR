pragma solidity ^0.6.2;

/** @title CapMath */
/** @author Zergity (https://endur.io) */

import "./util.sol";

library CapMath {
    uint256 constant MAX_UINT256 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    int256  constant MAX_INT256  = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    int256  constant MIN_INT256  = MAX_INT256 + 1;

    /// would not overflown with a <= b
    ///
    /// @return x*a/b or x/b*a
    function checkedScale(uint x, uint a, uint b) internal pure returns (uint) {
        if (a == 0) {
            return 0;
        }
        uint y = x * a;
        if (y / a == x) {
            return y / b;
        }
        // overflown
        return x/b*a;   // overflowable: only if a > b
    }

    /**
     * @dev assert(a <= b)
     * @return x * a / b (precision can be lower if (x*a) overflown)
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

        // TODO: binary search
        uint shifted;
        do {
            x >>= 1;
            ++shifted;
            y = x * a;
        } while(y / a != x);

        return (y / b) << shifted; // a <= b so this <= x (can't be overflown)
    }

    // capped addition
    // if the calculation is overflown, return the max or min value of the type
    function add(uint a, uint b) internal pure returns (uint) {
        uint256 c = a + b;
        if (c >= a) {
            return c;
        }
        return MAX_UINT256; // addition overflow
    }

    // capped subtraction
    // if the calculation is overflown, return the max or min value of the type
    function sub(uint a, uint b) internal pure returns (uint) {
        if (a <= b) {
            return 0;   // subtraction overflow
        }
        return a - b;
    }

    // capped multiply
    // if the calculation is overflown, return the max or min value of the type
    function mul(int a, int b) internal pure returns (int) {
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

        if (util.inStrictOrder(a, 0, b)) {
            return MIN_INT256;  // negative overflown
        }
        return MAX_INT256;  // positive overflown
    }

    // unsigned capped multiply
    // if the calculation is overflown, return the max value of uint256
    function mul(uint a, uint b) internal pure returns (uint) {
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

        return MAX_UINT256; // overflown
    }
}