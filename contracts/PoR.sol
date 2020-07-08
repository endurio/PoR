// SPDX-License-Identifier: MIT
pragma solidity >=0.5.10;

import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";
import {BTCUtils} from "./lib/bitcoin-spv/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "./lib/bitcoin-spv/contracts/CheckBitcoinSigs.sol";
import {ValidateSPV} from "./lib/bitcoin-spv/contracts/ValidateSPV.sol";

contract PoR {
    bytes constant ENDURIO = "endur.io";

    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    // using SafeMath for uint256;

    mapping(bytes20 => address) internal miners; // pubkey bytes32 => address
    mapping(bytes32 => BlockHeader) internal headers;
    mapping(bytes32 => Brand) internal brands; // keccak(brand.memo) => Brand

    struct Brand {
        address owner;
        uint reward;
        bytes memo;
    }

    struct BlockHeader {
        bytes32 merkleRoot;
        uint target;
        uint32  timestamp;

        // PoR data
        int minable; // ref count for winner keys
        mapping(bytes32 => Transaction) winner; // keccak(brand.memo) => winning tx
    }

    struct Transaction {
        bytes32 id;
        bytes32 outpointTxLE;
        bytes outpointIndexLE; // 4 bytes LE integer
    }

    constructor() internal {
        brands[keccak256(ENDURIO)] = Brand({
            owner: address(this),
            reward: 1e18,
            memo: ENDURIO
        });
        return;
    }

    function mine(
        bytes32 _blockHash,
        bytes32 _memoHash,
        bytes calldata _vin,    // outpoint tx input vector
        bytes calldata _vout,   // outpoint tx output vector
        uint32 _version,        // outpoint tx version
        uint32 _locktime,       // outpoint tx locktime
        uint64 _pkhIdx          // (optional) position of miner PKH in the outpoint raw data
                                // (including the first 8-bytes amount for optimization)
    ) external {
        BlockHeader storage header = headers[_blockHash];
        require(header.merkleRoot != 0, "no such block");
        Transaction storage winner = header.winner[_memoHash];
        require(winner.id != 0, "no such tx");

        bytes32 txId = ValidateSPV.calculateTxId(_version, _vin, _vout, _locktime);
        // TODO: endianness
        require(winner.outpointTxLE == txId, "outpoint tx mismatch");

        bytes memory output = _vout.extractOutputAtIndex(winner.outpointIndexLE.reverseEndianness().toUint32(0));
        bytes20 pkh = extractPKH(output, _pkhIdx);
        address miner = miners[pkh];
        require(miner != address(0x0), "unregistered PKH");

        // TODO: mint the token to miner
        // reward = brand.reward * header.target / RATE
        delete header.winner[_memoHash];

        if (header.minable > 1) {
            header.minable--;
        } else {
            // TODO: save this gas-refund for commitBlock to:
            // 1. disincentivize miner to delay the claim request for gas-refund
            // 2. incentivize commitBlock relayer
            delete headers[_blockHash];
        }
    }

    function extractPKH(
        bytes memory _output,
        uint64 _pkhIdx
    ) internal returns (bytes20) {
        // the first 8 bytes is ussually for amount, so zero index makes no sense here
        if (_pkhIdx > 0) {
            // pkh location is provided for saving gas
            return _output.slice(_pkhIdx, 20).toBytes20();
        }
        // standard outpoint types: p2pkh, p2wpkh
        bytes memory pkh = _output.extractHash();
        require(pkh.length == 20, "unsupported PKH in outpoint");
        return pkh.toBytes20();
    }

    /// @param _merkleProof     The proof's intermediate nodes (digests between leaf and root)
    /// @param _merkleIndex     The leaf's index in the tree (0-indexed)
    function commitTx(
        bytes32 _blockHash,
        bytes calldata _merkleProof,
        uint _merkleIndex,      // TODO: pack this
        bytes calldata _vin,    // tx input vector
        bytes calldata _vout,   // tx output vector
        uint32 _version,        // tx version
        uint32 _locktime,       // tx locktime
        uint32 _outputIndex,
        uint32 _inputIndex     // index of input which its outpoint locking script contains the miner PKH
        // TODO: pack the 5 params in an uint256
    ) external {
        BlockHeader storage header = headers[_blockHash];
        bytes32 merkleRoot = header.merkleRoot;
        require(merkleRoot != 0, "no such block");
        // TODO: verify outdated timestamp

        bytes32 txId = ValidateSPV.calculateTxId(_version, _vin, _vout, _locktime);
        require(ValidateSPV.prove(txId, merkleRoot, _merkleProof, _merkleIndex), "invalid merkle proof");

        // extract the brand from OP_RETURN
        bytes memory output = _vout.extractOutputAtIndex(_outputIndex);
        bytes memory memo = output.extractOpReturnData();
        require(memo.length > 0, "empty tx memo");

        // Brand memory brand = brands[tx.memo];
        // require(brand.owner != 0, "no such branch memo");
        // TODO: handle manual miner address in tx memo

        bytes memory input = _vin.extractInputAtIndex(_inputIndex);

        bytes32 memoHash = keccak256(memo);
        Transaction storage winner = header.winner[memoHash];
        if (winner.id != 0) {
            uint oldRank = txRank(_blockHash, winner.id);
            uint newRank = txRank(_blockHash, txId);
            require(newRank < oldRank, "not better than commited tx");
        } else {
            header.minable++; // increase the ref count for new brand
        }
        // store the outpoint to claim the reward later
        winner.outpointTxLE = input.extractInputTxIdLE();
        winner.outpointIndexLE = input.extractTxIndexLE();
        winner.id = txId;
    }

    function commitBlock(
        bytes calldata _header,
        bytes32 _outdatedBlockHash   // optional outdated block to clean up for gas re-fund
    ) external {
        // header can be of any size
        uint target = _header.extractTarget();

        // Require that the header has sufficient work
        bytes32 _blockHash = _header.hash256View();
        require(uint(_blockHash).reverseUint256() <= target, "insufficient work for block");

        // TODO: verify block timestamp > genesis timestamp

        BlockHeader storage header = headers[_blockHash];
        require(header.merkleRoot == 0, "block committed");

        header.merkleRoot = _header.extractMerkleRootLE().toBytes32();
        header.timestamp = _header.extractTimestamp();
        header.target = target;

        // TODO: implement this
        // cleaning up for gas re-fund
        // if (_outdatedBlock != 0) {
        //     BlockHeader memory outdatedHeader = headers[_outdatedBlockHash];
        // }
    }

    function txRank(bytes32 blockHash, bytes32 txHash) internal pure returns (uint) {
        return uint(keccak256(abi.encodePacked(blockHash, txHash)));
    }

    function registerPKH(
        bytes memory _pubkey
    ) internal {
        address adr = CheckBitcoinSigs.accountFromPubkey(_pubkey);
        bytes20 pkh = getPKH(_pubkey);
        miners[pkh] = adr; // store the mapping for re-use
    }

    // TODO: changePKH, or something to clear out the unused PKH

    function getPKH(
        bytes memory _pubkey
    ) internal pure returns (bytes20 pkh) {
        return ripemd160(abi.encodePacked(sha256(_pubkey)));
    }
}
