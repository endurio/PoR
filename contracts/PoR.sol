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
        bytes32 _blockHash,     // big-endian
        bytes32 _memoHash
    ) external {
        Header storage header = headers[_blockHash];
        Transaction storage winner = _mustGetBlockWinner(header, _memoHash);

        { // stack too deep
        bytes20 pkh = winner.pkh;
        require(pkh != 0, "PubKey or PKH not relayed, use claimWithPrevTx instead");
        _reward(_memoHash, pkh, MAX_TARGET / header.target, winner.multiplier);
        }

        _cleanUpWinner(_blockHash, _memoHash);
    }

    function claimWithPrevTx(
        bytes32 _blockHash,     // big-endian
        bytes32 _memoHash,
        bytes calldata _vin,    // outpoint tx input vector
        bytes calldata _vout,   // outpoint tx output vector
        bytes32 _extra
            // uint32 EXTRA_PKH_IDX,    // (optional) position of miner PKH in the outpoint raw data
                                        // (including the first 8-bytes amount for optimization)
            // uint32 EXTRA_LOCKTIME,   // tx locktime
            // uint32 EXTRA_VERSION,    // tx version
    ) external {
        Header storage header = headers[_blockHash];
        Transaction storage winner = _mustGetBlockWinner(header, _memoHash);

        { // stack too deep
        bytes32 outpointTxLE = winner.outpointTxLE;
        require(outpointTxLE != 0, "PubKey or PKH already relayed, use claim instead");
        bytes32 txId = ValidateSPV.calculateTxId(
            extractUint32(_extra, EXTRA_VERSION),
            _vin,
            _vout,
            extractUint32(_extra, EXTRA_LOCKTIME));
        require(outpointTxLE == txId, "outpoint tx mismatch");
        }

        { // stack too deep
        bytes memory output = _vout.extractOutputAtIndex(winner.outpointIdx);
        bytes20 pkh = extractPKH(output, extractUint32(_extra, EXTRA_PKH_IDX));
        _reward(_memoHash, pkh, MAX_TARGET / header.target, winner.multiplier);
        }

        _cleanUpWinner(_blockHash, _memoHash);
    }

    function _mustGetBlockWinner(
        Header storage header,
        bytes32 _memoHash
    ) internal view returns (Transaction storage winner) {
        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        require(!_minable(timestamp), "mining time not over");
        }

        winner = header.winner[_memoHash];
        require(winner.id != 0, "no tx commited");
    }

    function _cleanUpWinner(bytes32 _blockHash, bytes32 _memoHash) internal {
        Header storage header = headers[_blockHash];
        delete header.winner[_memoHash];

        if (header.minable > 1) {
            header.minable--;
        } else {
            delete headers[_blockHash];

            // TODO: clean up and rate adjustment here
        }
    }

    /**
     * for PoR to pay for the miner
     */
    function _reward(
        bytes32 memoHash,
        bytes20 pkh,
        uint rewardRate,
        uint multiplier
    ) internal {
        address payee = miners[pkh];
        require(payee != address(0x0), "unregistered PKH");
        if (multiplier > 1) {
            rewardRate *= multiplier;
        }
        uint paid = _claimReward(memoHash, rewardRate);
        _payReward(payee, paid);    // reward the miner and upstream in the ref network
        Brand storage brand = brands[memoHash];
        emit Reward(memoHash, brand.memo.toBytes32(), brand.payer, payee, rewardRate);
    }

    /**
     * take the token from the brand (or mint for ENDURIO) to pay for miner and the network
     */
    function _claimReward(bytes32 memoHash, uint rewardRate) internal returns (uint) {
        if (memoHash == ENDURIO_MEMO_HASH) {
            _mint(address(this), rewardRate);
            return rewardRate;
        }
        Brand storage brand = brands[memoHash];
        uint payRate = brand.payRate.committed();
        require(payRate > 0, "brand not active");
        uint amount = util.mulCap(payRate, rewardRate) / 1e18;
        uint balance = brand.balance;
        if (amount < balance) {
            balance -= amount; // safe
            brand.balance = balance;
            if (balance < payRate * ACTIVE_CONDITION_PAYRATE) {
                // schedule the deactivation
                brand.payRate.schedule(0, PAYRATE_DELAY);
                emit Deactive(memoHash);
            }
            return amount;
        } else {
            // exhaust the balance
            delete brand.balance;
            // forced commit a deactivation
            brand.payRate.commit(0);
            emit Deactive(memoHash);
            return balance;
        }
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

    function extractPKH(
        bytes memory _output,
        uint32 _pkhIdx
    ) internal pure returns (bytes20) {
        // the first 8 bytes is ussually for amount, so zero index makes no sense here
        if (_pkhIdx > 0) {
            // pkh location is provided for saving gas
            return bytes20(_output.slice(_pkhIdx, 20).toBytes32());
        }
        // standard outpoint types: p2pkh, p2wpkh
        bytes memory pkh = _output.extractHash();
        require(pkh.length == 20, "unsupported PKH in outpoint");
        return bytes20(pkh.toBytes32());
    }

    /// @param _merkleProof The proof's intermediate nodes (digests between leaf and root)
    /// @param _extra       All the following params packed in a single bytes32
    ///     uint32 EXTRA_MERKLE_IDX  // the merkle leaf's index in the tree (0-indexed)
    ///     uint32 EXTRA_MEMO_LENGTH // (optional) memo lengh in OP_RET to add extra user memo after the brand
    ///     uint32
    ///     uint32 EXTRA_PUBKEY_POS  // (optional) index of 33-bytes compressed PubKey in input redeem script
    ///     uint32 EXTRA_INPUT_IDX   // index of input which its outpoint locking script contains the miner PKH
    ///     uint32 EXTRA_OUTPUT_IDX  // index of OP_RET output
    ///     uint32 EXTRA_LOCKTIME    // tx locktime, little endian
    ///     uint32 EXTRA_VERSION     // tx version, little endian
    function commitTx(
        bytes32 _blockHash,
        bytes calldata _merkleProof,
        bytes32 _extra,
        bytes calldata _vin,    // tx input vector
        bytes calldata _vout    // tx output vector
    ) external {
        Header storage header = headers[_blockHash];

        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        require(_minable(timestamp), "mining time over");
        }

        bytes32 txId = ValidateSPV.calculateTxId(
            extractUint32(_extra, EXTRA_VERSION),
            _vin,
            _vout,
            extractUint32(_extra, EXTRA_LOCKTIME));

        require(ValidateSPV.prove(txId, header.merkleRoot, _merkleProof, extractUint32(_extra, EXTRA_MERKLE_IDX)), "invalid merkle proof");

        // extract the brand from OP_RETURN
        Transaction storage winner = _mustBeNewWinner(
            _blockHash,
            txId,
            _vout.extractOutputAtIndex(extractUint32(_extra, EXTRA_OUTPUT_IDX)).extractOpReturnData(),
            extractUint32(_extra, EXTRA_MEMO_LENGTH)
        );

        // TODO: handle manual miner address in tx memo

        // store the outpoint to claim the reward later
        bytes memory input = _vin.extractInputAtIndex(extractUint32(_extra, EXTRA_INPUT_IDX));
        uint posPK = extractUint32(_extra, EXTRA_PUBKEY_POS);

        if (posPK > 0) {
            // custom P2SH redeem script with compressed PubKey
            winner.pkh = getPKH(input.slice(32+4+1+posPK, 33));
        } else if (input.keccak256Slice(32+4, 4) == 0x54a7e824f373257a8e97cc251e08041c2e042cf00fa33051e7ed3604fe21e846) { // keccak256(hex"17160014")
            // redeem script for P2SH-P2WPKH
            winner.pkh = bytes20(input.slice(32+4+4, 20).toBytes32());
        } else if (input.length >= 32+4+1+33+4 && input[input.length-1-33-4] == 0x21) {
            // redeem script for P2PKH
            winner.pkh = getPKH(input.slice(input.length-33-4, 33));
        } else {
            winner.outpointIdx = input.extractTxIndexLE().reverseEndianness().toUint32(0);
            winner.outpointTxLE = input.extractInputTxIdLE();
        }

        winner.id = txId;
    }

    function _mustBeNewWinner(
        bytes32 _blockHash,
        bytes32 txId,
        bytes memory opret,
        uint memoLength
    ) internal returns (Transaction storage winner) {
        Header storage header = headers[_blockHash];
        uint multiplier;
        if (memoLength == 0) {
            winner = header.winner[keccak256(opret)];
        } else {
            require(opret.length >= memoLength, "memo length too long for opret");
            winner = header.winner[opret.keccak256Slice(0, memoLength)];
            if (opret.length > memoLength + 2 &&
                opret[memoLength]   == ' ' &&
                opret[memoLength+1] == 'x'
            ) {
                multiplier = _readUint(opret, memoLength + 2);
                if (multiplier > 1) {
                    require(uint(_blockHash) < header.target / multiplier, "insufficient work for multiplied target");
                }
            }
        }

        if (winner.id != 0) {
            uint oldRank = txRank(_blockHash, winner.id);
            uint newRank = txRank(_blockHash, txId);
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
        winner.multiplier = multiplier;
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

    function extractUint32(bytes32 packed, uint shift) internal pure returns (uint32) {
        return uint32((uint(packed) >> shift) & 0xFFFFFFFF);
    }

    /// TODO: create an incentive for only 1 miner to relay the block header
    function commitBlock(
        bytes calldata _header
    ) external {
        uint _blockHash = uint(_header.hash256()).reverseUint256(); // always use BE for block hash
        Header storage header = headers[bytes32(_blockHash)];
        require(header.merkleRoot == 0, "block committed");

        // header can be of any size
        uint target = _header.extractTarget();
        // Require that the header has sufficient work
        require(_blockHash <= target, "insufficient work");

        uint32 timestamp = _header.extractTimestamp();
        require(_minable(timestamp), "block too old");

        header.merkleRoot = _header.extractMerkleRootLE().toBytes32();
        header.timestamp = timestamp;
        header.target = target;
        // TODO: emit Block(bytes32(_blockHash))
    }

    /**
     * testing whether the given timestamp is in the commit time
     */
    function _minable(uint timestamp) internal view returns (bool) {
        return time.elapse(timestamp) < MINING_TIME;
    }

    function txRank(bytes32 blockHash, bytes32 txHash) internal pure returns (uint) {
        return uint(keccak256(abi.encodePacked(blockHash, txHash)));
    }

    function registerMiner(
        bytes calldata _pubkey, // uncompressed, unprefixed 64-bytes pubic key
        address _beneficient    // (optional) rewarding address
    ) external {
        address adr = CheckBitcoinSigs.accountFromPubkey(_pubkey);
        if (_beneficient != address(0x0)) {
            require(msg.sender == adr, "only pkh owner can change the beneficient address");
            adr = _beneficient;
        }
        bytes20 pkh = getPKH(compressPK(_pubkey));
        miners[pkh] = adr;
    }

    function changeMiner(
        bytes20 _pkh,
        address _beneficient
    ) external {
        require(msg.sender == miners[_pkh], "only for old owner");
        miners[_pkh] = _beneficient;
    }

    function getPKH(
        bytes memory compressedPubkey    // compressed, refixed 33-bytes pubic key
    ) internal pure returns (bytes20 pkh) {
        return ripemd160(abi.encodePacked(sha256(compressedPubkey)));
    }

    function compressPK(
        bytes memory _pubkey    // uncompressed, unprefixed 64-bytes pubic key
    ) internal pure returns (bytes memory) {
        uint8 _prefix = uint8(_pubkey[_pubkey.length - 1]) % 2 == 1 ? 3 : 2;
        return abi.encodePacked(_prefix, _pubkey.slice(0, 32));
    }
}
