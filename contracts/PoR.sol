// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;
pragma experimental ABIEncoderV2;

import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";
import {BTCUtils} from "./lib/bitcoin-spv/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "./lib/bitcoin-spv/contracts/CheckBitcoinSigs.sol";
import {ValidateSPV} from "./lib/bitcoin-spv/contracts/ValidateSPV.sol";
import "./interface/IRefNet.sol";
import "./lib/CapMath.sol";
import "./DataStructure.sol";
import "./lib/time.sol";

interface IERC20Events {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

/**
 * Proof of Reference
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract PoR is DataStructure, IERC20Events {
    uint constant MINING_TIME = 1 hours;
    uint constant BOUNTY_TIME = 1 hours;
    uint constant RECIPIENT_RATE = 32;

    uint constant MAX_TARGET = 1<<240;

    // extra param bit posistion (from the right)
    uint constant EXTRA_VERSION     = 32*0;
    uint constant EXTRA_LOCKTIME    = 32*1;
    uint constant EXTRA_MERKLE_IDX  = 32*2;
    uint constant EXTRA_INPUT_IDX   = 32*3;

    // bounty params
    uint constant BOUNTY_MINTXSIZE  = 32*0; // +32
    uint constant BOUNTY_TXSIZE     = 32*1; // +32
    uint constant BOUNTY_MINVALUE   = 32*2; // +64
    uint constant BOUNTY_TOTALVALUE = 32*4; // +64

    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    using Packed   for bytes32;

    function claim(
        bytes32 blockHash,  // big-endian
        bytes32 memoHash,
        address payer,
        bytes20 pkh,
        uint    amount,
        uint    timestamp
    ) external {
        Reward storage reward = rewards[blockHash][memoHash];
        require(reward.rank > 0, "!reward");  // !tx
        require(reward.commitment == bytes28(keccak256(abi.encodePacked(payer, pkh, amount, timestamp))), "commitment mismatch");
        require(!_minable(timestamp), "too soon");

        address miner = miners[pkh];
        require(miner != address(0x0), "unregistered PKH");
        IRefNet(address(this)).reward(miner, payer, amount, memoHash, blockHash);
        delete rewards[blockHash][memoHash];
    }

    // function getWinner(
    //     bytes32 blockHash,  // big-endian
    //     bytes32 memoHash
    // ) external view returns (
    //     bool    claimable,
    //     bytes32 id,
    //     uint    reward,
    //     address payer,
    //     bytes20 minerData,
    //     uint32  outpointIdx,
    //     TxState state
    // ) {
    //     Header storage header = headers[blockHash];
    //     Transaction storage winner = header.winner[memoHash];
    //     return (
    //         !_minable(header.timestamp),
    //         winner.id,
    //         winner.reward,
    //         winner.payer,
    //         winner.minerData,
    //         winner.outpointIdx,
    //         winner.state
    //     );
    // }

    function _extractPKH(
        bytes   memory  output,
        uint32          pkhIdx
    ) internal pure returns (bytes20) {
        // the first 8 bytes is ussually for amount, so zero index makes no sense here
        if (pkhIdx > 0) {
            // pkh location is provided for saving gas
            return bytes20(output.slice(pkhIdx, 20).toBytes32());
        }
        // standard outpoint types: p2pkh, p2wpkh
        bytes memory pkh = output.extractHash();
        require(pkh.length == 20, "unsupported PKH in outpoint");
        return bytes20(pkh.toBytes32());
    }

    struct ParamCommit {
        // brand
        address payer;

        // block
        bytes   header;
        uint32  merkleIndex;
        bytes   merkleProof;

        // tx
        uint32  version;
        uint32  locktime;
        bytes   vin;
        bytes   vout;

        // PoR
        uint32  inputIndex;
        uint32  memoLength;
        uint32  pubkeyPos;
    }

    struct ParamOutpoint {
        uint32  pkhPos;     // (optional) position of miner PKH in the outpoint raw data
                            // (including the first 8-bytes amount for optimization)
        // tx
        uint32  version;
        uint32  locktime;
        bytes   vin;
        bytes   vout;
    }

    struct ParamBounty {
        // block
        bytes   header;
        uint32  merkleIndex;
        bytes   merkleProof;

        // tx
        uint32  version;
        uint32  locktime;
        bytes   vin;
        bytes   vout;

        ParamTx[] inputs;
    }

    struct ParamTx {
        uint32  version;
        uint32  locktime;
        bytes   vin;
        bytes   vout;
    }

    function commit(
        ParamCommit     calldata    params,
        ParamOutpoint[] calldata    outpoint,
        ParamBounty[]   calldata    bounty
    ) external {
        // block
        uint blockHash = uint(params.header.hash256()).reverseUint256(); // always use BE for block hash
        uint rewardRate = MAX_TARGET;

        if (bounty.length > 0) {
            require(bounty[0].vout.extractFirstOpReturn().length == 0, "bounty: sampling recipient has OP_RET");

            uint inValue;
            uint firstInputSize;

            { // stack too deep
            bytes32[] memory outpointHash;
            uint[] memory outpointIdx;
            (firstInputSize, outpointHash, outpointIdx) = params.vin.processBountyInputs();
            for (uint i = 0; i < outpointHash.length; ++i) {
                require (outpointHash[i] ==
                    ValidateSPV.calculateTxId(
                        bounty[0].inputs[i].version,
                        bounty[0].inputs[i].vin,
                        bounty[0].inputs[i].vout,
                        bounty[0].inputs[i].locktime
                    ), 'bounty: inputs mismatch');
                inValue += bounty[0].inputs[i].vout.extractOutputAtIndex(outpointIdx[i]).extractValue(); // unsafe
            }

            bytes32 sid = ValidateSPV.calculateTxId(bounty[0].version, bounty[0].vin, bounty[0].vout, bounty[0].locktime);
            // TODO: change the way recipient is seleced to remove this reverseEndianness
            require(uint(keccak256(abi.encodePacked(sid, outpointHash[0]).reverseEndianness())) % RECIPIENT_RATE == 0, "bounty: unacceptable recipient");
            require(ValidateSPV.prove(
                sid,
                bounty[0].header.extractMerkleRootLE().toBytes32(),
                bounty[0].merkleProof,
                bounty[0].merkleIndex
            ), "bounty: invalid merkle proof");
            }

            rewardRate *= 2 * params.vout.processBountyOutputs(
                params.vin.length,
                keccak256(bounty[0].vout.extractOutputAtIndex(uint(-1)).extractScript()),
                inValue,
                firstInputSize,
                blockHash);
        }

        bytes32 memoHash;

        { // stack too deep
        uint target = params.header.extractTarget();

        if (bounty.length > 1) {
            uint bountyTarget = bounty[0].header.extractTarget();
            // Require that the header has sufficient work
            require(uint(bounty[0].header.hash256()).reverseUint256() <= bountyTarget, "bounty: insufficient work");
            // bounty reference block must have the same target as the mining block

            // A single (BTC) retarget never changes the target by more than a factor of 4 either way to prevent large changes in difficulty.
            // To support more re-targeting protocols and testnet, we limit to factor of 2 upward before triggering an expensive reward retarget.
            bountyTarget /= target;
            if (target >= 2) { // bounty reference block target is too week
                rewardRate /= bountyTarget;
            }
        }

        uint multiplier;
        (memoHash, multiplier) = _processMemo(params.vout.extractFirstOpReturn(), params.memoLength);
        if (multiplier > 1) {
            target /= multiplier;
        }
        // Require that the header has sufficient work
        require(blockHash <= target, "insufficient work");
        rewardRate /= target;
        }

        Reward storage reward = rewards[bytes32(blockHash)][memoHash];

        // tx
        { // stack too deep 
        bytes32 txid = ValidateSPV.calculateTxId(params.version, params.vin, params.vout, params.locktime);
        require(ValidateSPV.prove(txid, params.header.extractMerkleRootLE().toBytes32(), params.merkleProof, params.merkleIndex), "invalid merkle proof");

        uint32 rank = uint32(bytes4(keccak256(abi.encodePacked(blockHash, txid))));
        if (reward.rank != 0) {
            // accept the same rank here to allow re-commiting the same tx to change the input index
            require(rank <= reward.rank, "better tx committed");
        }
        reward.rank = rank;
        }

        bytes20 pkh;
        { // stack too deep
        // store the outpoint to claim the reward later
        bytes memory input = params.vin.extractInputAtIndex(params.inputIndex);
        
        if (params.pubkeyPos > 0) {
            // custom P2SH redeem script with manual compressed PubKey position
            pkh = _getPKH(input.slice(32+4+1+params.pubkeyPos, 33));
        } else if (input.keccak256Slice(32+4, 4) == keccak256(hex"17160014")) {
            // redeem script for P2SH-P2WPKH
            pkh = bytes20(input.slice(32+4+4, 20).toBytes32());
        } else if (input.length >= 32+4+1+33+4 && input[input.length-1-33-4] == 0x21) {
            // redeem script for P2PKH
            pkh = _getPKH(input.slice(input.length-33-4, 33));
        } else {
            // redeem script for P2WPKH
            require(outpoint.length > 0, "!outpoint");
            bytes32 otxid = ValidateSPV.calculateTxId(outpoint[0].version, outpoint[0].vin, outpoint[0].vout, outpoint[0].locktime);
            require(otxid == input.extractInputTxIdLE(), "outpoint mismatch");
            uint oIdx = input.extractTxIndexLE().reverseEndianness().toUint32(0);
            bytes memory output = outpoint[0].vout.extractOutputAtIndex(oIdx);
            pkh = _extractPKH(output, outpoint[0].pkhPos);
        }
        }

        uint timestamp = params.header.extractTimestamp();
        require(_minable(timestamp), "mining time over");
        if (bounty.length > 1) {
            require(timestamp - bounty[0].header.extractTimestamp() <= BOUNTY_TIME, "bounty: block too old");
        }

        uint amount = _getBrandReward(memoHash, params.payer, rewardRate);

        reward.commitment = bytes28(keccak256(abi.encodePacked(params.payer, pkh, amount, timestamp)));
        emit Mined(memoHash, params.payer, pkh, amount, timestamp, bytes32(blockHash));
    }

    function _processMemo(
        bytes   memory  opret,
        uint            memoLength
    ) internal pure returns (bytes32 memoHash, uint multiplier) {
        require(opret.length > 0, "!OP_RET");
        if (memoLength == 0) {
            return (keccak256(opret), 1);
        }
        require(opret.length >= memoLength, "OOB: memo length");
        memoHash = opret.keccak256Slice(0, memoLength);
        if (opret.length > memoLength + 2 &&
            opret[memoLength]   == ' ' &&
            opret[memoLength+1] == 'x'
        ) {
            multiplier = _readUint(opret, memoLength + 2);
        }
    }

    function _getBrandReward(
        bytes32 memoHash,
        address payer,
        uint    rewardRate
    ) internal view returns (uint) {
        if (memoHash == ENDURIO_MEMO_HASH) {
            return rewardRate;
        }
        Brand storage brand = brands[memoHash][payer];
        uint payRate = brand.payRate;   // TODO: is the expiration checked here?
        require(payRate > 0, "brand not active");
        return CapMath.mul(payRate, rewardRate) / ENDURIO_PAYRATE;
    }

    function _readUint(bytes memory b, uint start) internal pure returns (uint result) {
        for (uint i = start; i < b.length; i++) {
            uint c = uint(uint8(b[i]));
            if (c < 48 || c > 57) {
                break;
            }
            result = result * 10 + (c - 48);
        }
    }

    /**
     * testing whether the given timestamp is in the commit time
     */
    function _minable(uint timestamp) internal view returns (bool) {
        return time.elapse(timestamp) < MINING_TIME;
    }

    // TODO: move miner functions to other contract
    function registerMiner(
        bytes   calldata    pubkey,     // uncompressed, unprefixed 64-bytes pubic key
        address             beneficient // (optional) rewarding address
    ) external {
        address adr = CheckBitcoinSigs.accountFromPubkey(pubkey);
        if (beneficient != address(0x0)) {
            require(msg.sender == adr, "only pkh owner can change the beneficient address");
            adr = beneficient;
        }
        bytes20 pkh = _getPKH(_compressPK(pubkey));
        miners[pkh] = adr;
    }

    function changeMiner(
        bytes20 pkh,
        address beneficient
    ) external {
        require(msg.sender == miners[pkh], "only for old owner");
        miners[pkh] = beneficient;
    }

    function _getPKH(
        bytes memory compressedPubkey    // compressed, prefixed 33-bytes pubic key
    ) internal pure returns (bytes20 pkh) {
        return ripemd160(abi.encodePacked(sha256(compressedPubkey)));
    }

    function _compressPK(
        bytes memory pubkey    // uncompressed, unprefixed 64-bytes pubic key
    ) internal pure returns (bytes memory) {
        uint8 prefix = uint8(pubkey[pubkey.length - 1]) % 2 == 1 ? 3 : 2;
        return abi.encodePacked(prefix, pubkey.slice(0, 32));
    }
}
