// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";
import {BTCUtils} from "./lib/bitcoin-spv/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "./lib/bitcoin-spv/contracts/CheckBitcoinSigs.sol";
import {ValidateSPV} from "./lib/bitcoin-spv/contracts/ValidateSPV.sol";
import "./lib/util.sol";
import "./DataStructure.sol";
import "./lib/time.sol";

/**
 * Proof of Reference
 *
 * @dev implemetation class can't have any state variable, all state is located in DataStructure
 */
contract PoR is DataStructure {
    uint constant MINING_TIME = 1 hours;

    uint constant MAX_TARGET = 1<<240;

    // extra param bit posistion (from the right)
    uint constant EXTRA_VERSION     = 0;
    uint constant EXTRA_LOCKTIME    = 32;
    uint constant EXTRA_PKH_IDX     = 32*2;
    uint constant EXTRA_OUTPUT_IDX  = 32*2;
    uint constant EXTRA_INPUT_IDX   = 32*3;
    uint constant EXTRA_PUBKEY_POS  = 32*4;
    // uint constant EXTRA_MINER_POS = 32*5;
    uint constant EXTRA_MEMO_LENGTH = 32*6;
    uint constant EXTRA_MERKLE_IDX  = 32*7;

    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    // using SafeMath for uint256;

    function claim(
        bytes32 blockHash,  // big-endian
        bytes32 memoHash
    ) external {
        Header storage header = headers[blockHash];
        Transaction storage winner = _mustGetBlockWinner(header, memoHash);

        { // stack too deep
        bytes20 pkh = winner.pkh;
        require(pkh != 0, "PubKey or PKH not relayed, use claimWithPrevTx instead");
        _reward(memoHash, winner.payer, pkh, winner.reward);
        }

        _cleanUpWinner(blockHash, memoHash);
    }

    function claimWithPrevTx(
        bytes32             blockHash,     // big-endian
        bytes32             memoHash,
        bytes   calldata    vin,    // outpoint tx input vector
        bytes   calldata    vout,   // outpoint tx output vector
        bytes32             extra
            // uint32 EXTRA_PKH_IDX,    // (optional) position of miner PKH in the outpoint raw data
                                        // (including the first 8-bytes amount for optimization)
            // uint32 EXTRA_LOCKTIME,   // tx locktime
            // uint32 EXTRA_VERSION,    // tx version
    ) external {
        Header storage header = headers[blockHash];
        Transaction storage winner = _mustGetBlockWinner(header, memoHash);

        { // stack too deep
        bytes32 outpointTxLE = winner.outpointTxLE;
        require(outpointTxLE != 0, "PubKey or PKH already relayed, use claim instead");
        bytes32 txId = ValidateSPV.calculateTxId(
            _extractUint32(extra, EXTRA_VERSION),
            vin,
            vout,
            _extractUint32(extra, EXTRA_LOCKTIME));
        require(outpointTxLE == txId, "outpoint tx mismatch");
        }

        { // stack too deep
        bytes memory output = vout.extractOutputAtIndex(winner.outpointIdx);
        bytes20 pkh = _extractPKH(output, _extractUint32(extra, EXTRA_PKH_IDX));
        _reward(memoHash, winner.payer, pkh, winner.reward);
        }

        _cleanUpWinner(blockHash, memoHash);
    }

    function _mustGetBlockWinner(
        Header  storage header,
        bytes32         memoHash
    ) internal view returns (Transaction storage winner) {
        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        require(!_minable(timestamp), "mining time not over");
        }

        winner = header.winner[memoHash];
        require(winner.id != 0, "no tx commited");
    }

    function _cleanUpWinner(bytes32 blockHash, bytes32 memoHash) internal {
        Header storage header = headers[blockHash];
        delete header.winner[memoHash];

        if (header.minable > 1) {
            header.minable--;
        } else {
            delete headers[blockHash];

            // TODO: clean up and rate adjustment here
        }
    }

    /**
     * for PoR to pay for the miner
     */
    function _reward(
        bytes32 memoHash,
        address payer,
        bytes20 pkh,
        uint    amount
    ) internal {
        address payee = miners[pkh];
        require(payee != address(0x0), "unregistered PKH");
        uint paid = _claimReward(memoHash, payer, amount);
        _payReward(payee, paid);    // reward the miner and upstream in the ref network
        emit Reward(memoHash, payer, payee, paid);
    }

    /**
     * take the token from the brand (or mint for ENDURIO) to pay for miner and the network
     */
    function _claimReward(
        bytes32 memoHash,
        address payer,
        uint    amount
    ) internal returns (uint) {
        if (memoHash == ENDURIO_MEMO_HASH) {
            _mint(address(this), amount);
            return amount;
        }
        Brand storage brand = brands[memoHash][payer];
        uint balance = brand.balance;
        if (amount < balance) {
            brand.balance -= amount; // safe
            return amount;
        }
        delete brands[memoHash][payer];
        emit Deactive(memoHash, payer);
        return balance;
    }

    /**
     * reward the miner an amount of token, and commit another amount of token to the upstream referal
     *
     * Note: half of the reward is distributed to miner, the other half is for upstream commission.
     */
    function _payReward(address miner, uint amount) internal {
        Node storage node = nodes[miner];
        if (!node.exists()) {
            _attach(miner, ROOT_ADDRESS);
        }
        assert(node.exists());
        uint commission = amount >> 1;
        node.balance.add(amount - commission); // safe
        _payUpstream(node, commission);
        epochTotalReward = util.addCap(epochTotalReward, amount);
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

    /// @param merkleProof The proof's intermediate nodes (digests between leaf and root)
    /// @param extra       All the following params packed in a single bytes32
    ///     uint32 EXTRA_MERKLE_IDX  // the merkle leaf's index in the tree (0-indexed)
    ///     uint32 EXTRA_MEMO_LENGTH // (optional) memo lengh in OP_RET to add extra user memo after the brand
    ///     uint32
    ///     uint32 EXTRA_PUBKEY_POS  // (optional) index of 33-bytes compressed PubKey in input redeem script
    ///     uint32 EXTRA_INPUT_IDX   // index of input which its outpoint locking script contains the miner PKH
    ///     uint32 EXTRA_OUTPUT_IDX  // index of OP_RET output
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
        Header storage header = headers[blockHash];

        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        require(_minable(timestamp), "mining time over");
        }

        bytes32 txId = ValidateSPV.calculateTxId(
            _extractUint32(extra, EXTRA_VERSION),
            vin,
            vout,
            _extractUint32(extra, EXTRA_LOCKTIME));

        require(ValidateSPV.prove(txId, header.merkleRoot, merkleProof, _extractUint32(extra, EXTRA_MERKLE_IDX)), "invalid merkle proof");

        // extract the brand from OP_RETURN
        Transaction storage winner = _processTxMemo(
            blockHash,
            txId,
            vout.extractOutputAtIndex(_extractUint32(extra, EXTRA_OUTPUT_IDX)).extractOpReturnData(),
            _extractUint32(extra, EXTRA_MEMO_LENGTH),
            payer
        );

        // TODO: handle manual miner address in tx memo

        // store the outpoint to claim the reward later
        bytes memory input = vin.extractInputAtIndex(_extractUint32(extra, EXTRA_INPUT_IDX));
        uint posPK = _extractUint32(extra, EXTRA_PUBKEY_POS);

        if (posPK > 0) {
            // custom P2SH redeem script with manual compressed PubKey position
            winner.pkh = _getPKH(input.slice(32+4+1+posPK, 33));
        } else if (input.keccak256Slice(32+4, 4) == keccak256(hex"17160014")) {
            // redeem script for P2SH-P2WPKH
            winner.pkh = bytes20(input.slice(32+4+4, 20).toBytes32());
        } else if (input.length >= 32+4+1+33+4 && input[input.length-1-33-4] == 0x21) {
            // redeem script for P2PKH
            winner.pkh = _getPKH(input.slice(input.length-33-4, 33));
        } else {
            winner.outpointIdx = input.extractTxIndexLE().reverseEndianness().toUint32(0);
            winner.outpointTxLE = input.extractInputTxIdLE();
        }

        winner.id = txId;
    }

    function getBlockWinner(
        bytes32 blockHash,
        bytes32 memoHash
    ) external view returns (
        bytes32 id,
        uint    reward,
        address payer,
        bytes32 outpointTxLE,
        uint32  outpointIdx,
        bytes20 pkh
    ) {
        Header storage header = headers[blockHash];
        Transaction storage winner = header.winner[memoHash];
        return (
            winner.id,
            winner.reward,
            winner.payer,
            winner.outpointTxLE,
            winner.outpointIdx,
            winner.pkh
        );
    }

    function _processTxMemo(
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
            // clear the old data
            delete winner.pkh;
            delete winner.outpointIdx;
            delete winner.outpointTxLE;
        } else {
            header.minable++; // increase the ref count for new brand
        }

        // for both new and replacing winner
        winner.reward = _getBrandReward(memoHash, payer, rewardRate);
        winner.payer = payer;
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
        return util.mulCap(payRate, rewardRate) / ENDURIO_PAYRATE;
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

    function _extractUint32(bytes32 packed, uint shift) internal pure returns (uint32) {
        return uint32((uint(packed) >> shift) & 0xFFFFFFFF);
    }

    /// TODO: create an incentive for only 1 miner to relay the block header
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
        header.target = target;
        // TODO: emit Block(bytes32(blockHash))
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
        bytes memory compressedPubkey    // compressed, refixed 33-bytes pubic key
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
