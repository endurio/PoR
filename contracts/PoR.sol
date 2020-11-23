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
    uint constant EXTRA_MEMO_LENGTH = 32*4;
    uint constant EXTRA_PUBKEY_POS  = 32*5;     uint constant EXTRA_PKH_POS         = 32*5;

    uint constant EXTRA_FLAG_BOUNTY = 1<<255;

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
        bytes32 memoHash
    ) external {
        Transaction storage winner = _mustGetBlockWinner(blockHash, memoHash);
        _requireState(winner.state, TxState.PKH);
        _reward(blockHash, memoHash, winner.minerData);
    }

    /// @param extra       All the following params packed in a single bytes32
    ///     uint32 EXTRA_PKH_POS,   (optional) position of miner PKH in the outpoint raw data
    ///                             (including the first 8-bytes amount for optimization)
    ///     uint32
    ///     uint32
    ///     uint32
    ///     uint32 EXTRA_LOCKTIME,  tx locktime
    ///     uint32 EXTRA_VERSION,   tx version
    function claimWithPrevTx(
        bytes32             blockHash,     // big-endian
        bytes32             memoHash,
        bytes   calldata    vin,    // outpoint tx input vector
        bytes   calldata    vout,   // outpoint tx output vector
        bytes32             extra
    ) external {
        Transaction storage winner = _mustGetBlockWinner(blockHash, memoHash);
        _requireState(winner.state, TxState.OUTPOINT);

        { // stack too deep
        bytes32 txId = ValidateSPV.calculateTxId(extra.ui32(EXTRA_VERSION), vin, vout, extra.ui32(EXTRA_LOCKTIME));
        require(winner.minerData == bytes20(txId), "outpoint tx mismatch");
        }

        { // stack too deep
        bytes memory output = vout.extractOutputAtIndex(winner.outpointIdx);
        bytes20 pkh = _extractPKH(output, extra.ui32(EXTRA_PKH_POS));
        _reward(blockHash, memoHash, pkh);
        }
    }

    function _requireState(TxState state, TxState expected) internal pure {
        if (state == expected) return;
        require(state != TxState.PKH, "!OUTPOINT: use claim instead");
        require(state != TxState.OUTPOINT, "!PKH: use claimWithPrevTx instead");
        require(state != TxState.CLAIMED, "already claimed");
    }

    function _mustGetBlockWinner(
        bytes32 blockHash,
        bytes32 memoHash
    ) internal view returns (Transaction storage winner) {
        Header storage header = headers[blockHash];
        require(!_minable(header.timestamp), "mining time not over");  // including cleaned up timestamp
        winner = header.winner[memoHash];
        require(winner.id != 0, "!tx");
    }

    function getWinner(
        bytes32 blockHash,  // big-endian
        bytes32 memoHash
    ) external view returns (
        bool    claimable,
        bytes32 id,
        uint    reward,
        address payer,
        bytes20 minerData,
        uint32  outpointIdx,
        TxState state
    ) {
        Header storage header = headers[blockHash];
        Transaction storage winner = header.winner[memoHash];
        return (
            !_minable(header.timestamp),
            winner.id,
            winner.reward,
            winner.payer,
            winner.minerData,
            winner.outpointIdx,
            winner.state
        );
    }

    /**
     * for PoR to pay for the miner
     */
    function _reward(
        bytes32 blockHash,
        bytes32 memoHash,
        bytes20 pkh
    ) internal {
        address miner = miners[pkh];
        require(miner != address(0x0), "unregistered PKH");
        Transaction storage winner = headers[blockHash].winner[memoHash];
        address payer = memoHash == ENDURIO_MEMO_HASH ? address(0x0) : winner.payer;
        IRefNet(address(this)).reward(miner, payer, winner.reward, memoHash, blockHash);
        // TODO: removing _cleanUp seems to make the gas usage lower
        _cleanUp(blockHash, memoHash);
    }

    function _cleanUp(bytes32 blockHash, bytes32 memoHash) internal {
        Header storage header = headers[blockHash];
        delete header.winner[memoHash];

        if (header.relayer == msg.sender) {
            delete headers[blockHash];  // TODO: save this for some other time
        }
    }

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

    struct _Tx {
        bytes32 id;
        bytes32 bounty;
        bytes opret;
        bytes input;
    }

    /// @param words   All bytes32 params
    ///     bounty tx extra,
    ///     input tx extra,
    ///     input tx extra,
    ///     ...,
    ///     params,
    ///     memoHash,
    ///     blockHash,
    ///
    /// @param buffers   All bytes params
    ///     bounty tx vin, vout,
    ///     input tx vin, vout,
    ///     input tx vin, vout,
    ///     ...,
    ///     merkleProof,
    ///     headerBytes,
    ///
    /// extra   All the following params packed in a single bytes32
    ///     uint32 EXTRA_INPUT_IDX  outpoint index for each inputs
    ///     uint32 EXTRA_MERKLE_IDX the merkle leaf's index in the tree (0-indexed)
    ///     uint32 EXTRA_LOCKTIME,  tx locktime
    ///     uint32 EXTRA_VERSION,   tx version
    function claimBounty(
        bytes32[] calldata words,
        bytes[] calldata buffers
    ) external {
        // bytes32 blockHash = words[words.length-1]
        // bytes32 memoHash = words[words.length-2]
        // bytes32 params = words[words.length-3]

        // bytes memory headerBytes = buffers[buffers.length-1]
        // bytes memory merkleProof = buffers[buffers.length-2]

        { // stack too deep
        uint target = buffers[buffers.length-1].extractTarget();
        // Require that the header has sufficient work
        require(uint(buffers[buffers.length-1].hash256()).reverseUint256() <= target, "insufficient work");
        // bounty reference block must have the same target as the mining block
        require(target == headers[words[words.length-1]].target, "block target not match");
        }

        // overflowable but unexploitable
        require(buffers[buffers.length-1].extractTimestamp() - headers[words[words.length-1]].timestamp < BOUNTY_TIME, "ref block too far");

        Transaction storage winner = _mustGetBlockWinner(words[words.length-1], words[words.length-2]);
        require(winner.state != TxState.CLAIMED, "already claimed");
        require(winner.bounty != 0, "!bounty");

        { // stack too deep
        bytes32 extra = words[0];
        bytes32 recipient = ValidateSPV.calculateTxId(
            extra.ui32(EXTRA_VERSION),
            buffers[0],
            buffers[1],
            extra.ui32(EXTRA_LOCKTIME));
        require(ValidateSPV.prove(
            recipient,
            buffers[buffers.length-1].extractMerkleRootLE().toBytes32(),
            buffers[buffers.length-2],
            extra.ui32(EXTRA_MERKLE_IDX)
        ), "invalid merkle proof");
        require(uint(keccak256(abi.encodePacked(winner.id, recipient))) % RECIPIENT_RATE == 0, "bounty recipient");
        }

        // verify params and recipient script
        bytes memory bountyPreimage = abi.encodePacked(words[words.length-3], buffers[1].extractOutputAtIndex(uint(-1)).extractScript());

        // verify inputs and calculate tx fee
        uint64 inValue;
        for (uint i = 1; i < words.length-3; ++i) {
            bytes32 extra = words[i];
            bytes32 id = ValidateSPV.calculateTxId(extra.ui32(EXTRA_VERSION), buffers[i*2], buffers[i*2+1], extra.ui32(EXTRA_LOCKTIME));
            uint idx = extra.ui32(EXTRA_INPUT_IDX);
            inValue += buffers[i*2+1].extractOutputAtIndex(idx).extractValue();
            bountyPreimage = abi.encodePacked(bountyPreimage, id, abi.encodePacked(uint32(idx)).reverseEndianness());
        }

        require(winner.bounty == keccak256(bountyPreimage), "bounty not match");
    }

    /// @param merkleProof The proof's intermediate nodes (digests between leaf and root)
    /// @param extra       All the following params packed in a single bytes32
    ///     uint1  EXTRA_FLAG_BOUNTY
    ///     uint31
    ///     uint32
    ///     uint32 EXTRA_PUBKEY_POS  // (optional) index of 33-bytes compressed PubKey in input redeem script
    ///     uint32 EXTRA_MEMO_LENGTH // (optional) memo lengh in OP_RET to add extra user memo after the brand
    ///     uint32 EXTRA_INPUT_IDX   // index of input which its outpoint locking script contains the miner PKH
    ///     uint32 EXTRA_MERKLE_IDX  // the merkle leaf's index in the tree (0-indexed)
    ///     uint32 EXTRA_LOCKTIME    // tx locktime, little endian
    ///     uint32 EXTRA_VERSION     // tx version, little endian
    function commitTx(
        bytes32             blockHash,
        bytes   calldata    merkleProof,
        bytes32             extra,
        bytes   calldata    vin,    // tx input vector
        bytes   calldata    vout,   // tx output vector
        address             payer
    ) external {
        { // stack too deep
        uint32 timestamp = headers[blockHash].timestamp;
        require(timestamp != 0, "!block");
        require(_minable(timestamp), "mining time over");
        }

        _Tx memory _tx;
        _tx.id = ValidateSPV.calculateTxId(extra.ui32(EXTRA_VERSION), vin, vout, extra.ui32(EXTRA_LOCKTIME));
        require(ValidateSPV.prove(_tx.id, headers[blockHash].merkleRoot, merkleProof, extra.ui32(EXTRA_MERKLE_IDX)), "invalid merkle proof");

        if (extra.flag(EXTRA_FLAG_BOUNTY)) {
            (   bytes memory opret,
                bytes memory script,
                bytes memory inputs,
                bytes32 params
            ) = _processBounty(blockHash, vin, vout);
            _tx.opret = opret;
            _tx.bounty = keccak256(abi.encodePacked(params, script, inputs));
        } else {
            _tx.opret = vout.extractFirstOpReturn();
        }

        // extract the brand from the first output with OP_RETURN
        Transaction storage winner = _processTx(
            blockHash,
            _tx.id,
            _tx.opret,
            extra.ui32(EXTRA_MEMO_LENGTH),
            payer
        );

        winner.bounty = _tx.bounty;

        // store the outpoint to claim the reward later
        // TODO: move this to extractBountyInputs
        _tx.input = vin.extractInputAtIndex(extra.ui32(EXTRA_INPUT_IDX));
        uint posPK = extra.ui32(EXTRA_PUBKEY_POS);

        if (posPK > 0) {
            // custom P2SH redeem script with manual compressed PubKey position
            winner.state = TxState.PKH;
            winner.minerData = _getPKH(_tx.input.slice(32+4+1+posPK, 33));
        } else if (_tx.input.keccak256Slice(32+4, 4) == keccak256(hex"17160014")) {
            // redeem script for P2SH-P2WPKH
            winner.state = TxState.PKH;
            winner.minerData = bytes20(_tx.input.slice(32+4+4, 20).toBytes32());
        } else if (_tx.input.length >= 32+4+1+33+4 && _tx.input[_tx.input.length-1-33-4] == 0x21) {
            // redeem script for P2PKH
            winner.state = TxState.PKH;
            winner.minerData = _getPKH(_tx.input.slice(_tx.input.length-33-4, 33));
        } else {
            winner.state = TxState.OUTPOINT;
            winner.minerData = bytes20(_tx.input.extractInputTxIdLE());
            winner.outpointIdx = _tx.input.extractTxIndexLE().reverseEndianness().toUint32(0);
        }
    }

    function _processBounty(
        bytes32         blockHash,
        bytes   memory  vin,    // tx input vector
        bytes   memory  vout    // tx output vector
    ) internal pure returns (
        bytes memory opret,
        bytes memory script,
        bytes memory inputs,
        bytes32 params
    ) {
        uint outputSize;
        uint minValue;
        uint totalValue;
        uint inputSize;

        (   opret,
            script,
            outputSize,
            minValue,
            totalValue
        ) = vout.extractBountyOutputs(uint(blockHash));

        (inputSize, inputs) = vin.extractBountyInputs();

        // version(4) + nVins(1) + input + nVouts(1) + output + locktime(4)
        uint minTxSize = inputSize + outputSize + 10;
        // version(4) + vins + vouts + locktime(4)
        uint txSize = vin.length + vout.length + 8;
        uint packed =
            (MAX_UINT32 & minTxSize)    << BOUNTY_MINTXSIZE |
            (MAX_UINT32 & txSize)       << BOUNTY_TXSIZE    |
            (MAX_UINT64 & minValue)     << BOUNTY_MINVALUE  |
            (MAX_UINT64 & totalValue)   << BOUNTY_TOTALVALUE;

        params = bytes32(packed);
    }

    function processBounty(
        bytes32             blockHash,
        bytes   calldata    vin,    // tx input vector
        bytes   calldata    vout    // tx output vector
    ) external pure returns (
        bytes memory opret,
        bytes memory script,
        bytes memory inputs,
        bytes32 params
    ) {
        return _processBounty(blockHash, vin, vout);
    }

    function getBlockWinner(
        bytes32 blockHash,
        bytes32 memoHash
    ) external view returns (
        bytes32 id,
        uint    reward,
        address payer,
        bytes20 minerData,
        uint32  outpointIdx,        
        bytes32 bounty,
        TxState state
    ) {
        Header storage header = headers[blockHash];
        Transaction storage winner = header.winner[memoHash];
        return (
            winner.id,
            winner.reward,
            winner.payer,
            winner.minerData,
            winner.outpointIdx,
            winner.bounty,
            winner.state
        );
    }

    function _processTx(
        bytes32         blockHash,
        bytes32         txId,
        bytes   memory  opret,
        uint            memoLength,
        address         payer
    ) internal returns (Transaction storage winner) {
        Header storage header = headers[blockHash];
        uint rewardRate = MAX_TARGET / header.target;
        (bytes32 memoHash, uint multiplier) = _processMemo(opret, memoLength);
        if (multiplier > 1) {
            require(uint(blockHash) < header.target / multiplier, "insufficient work for multiplied target");
            rewardRate *= multiplier;
        }

        winner = header.winner[memoHash];

        if (winner.id != 0) {
            uint oldRank = _txRank(blockHash, winner.id);
            uint newRank = _txRank(blockHash, txId);
            // accept the same rank here to allow re-commiting the same tx to change the input index
            require(newRank <= oldRank, "better tx committed");
        }

        // for both new and replacing winner
        winner.reward = _getBrandReward(memoHash, payer, rewardRate);
        winner.payer = payer;
        winner.id = txId;
    }

    function _processMemo(
        bytes   memory  opret,
        uint            memoLength
    ) internal pure returns (bytes32 memoHash, uint multiplier) {
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
        uint payRate = brand.payRate;
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

    // block data will be cleaned up when claim is called by the same sender of commitBlock
    function commitBlock(
        bytes calldata headerBytes
    ) external {
        uint blockHash = uint(headerBytes.hash256()).reverseUint256(); // always use BE for block hash
        Header storage header = headers[bytes32(blockHash)];
        require(header.merkleRoot == 0, "block committed");

        // header can be of any size
        uint target = headerBytes.extractTarget();
        // Require that the header has sufficient work
        require(blockHash <= target, "insufficient work");

        uint32 timestamp = headerBytes.extractTimestamp();
        require(_minable(timestamp), "block too old");

        header.merkleRoot = headerBytes.extractMerkleRootLE().toBytes32();
        header.timestamp = timestamp;
        header.relayer = msg.sender;
        header.target = target;
    }

    /**
     * testing whether the given timestamp is in the commit time
     */
    function _minable(uint timestamp) internal view returns (bool) {
        return time.elapse(timestamp) < MINING_TIME;
    }

    function _txRank(bytes32 blockHash, bytes32 txHash) internal pure returns (uint) {
        return uint(keccak256(abi.encodePacked(blockHash, txHash)));
    }

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
