// SPDX-License-Identifier: MIT
pragma solidity >=0.5.10;

import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";
import {BTCUtils} from "./lib/bitcoin-spv/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "./lib/bitcoin-spv/contracts/CheckBitcoinSigs.sol";
import {ValidateSPV} from "./lib/bitcoin-spv/contracts/ValidateSPV.sol";

contract PoR {
    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    // using SafeMath for uint256;

    mapping(bytes20 => address) internal pkhs; // pubkey bytes32 => address
    mapping(bytes32 => BlockHeader) internal headers;
    mapping(bytes => Brand) internal brands;

    struct Brand {
        address owner;
        uint reward;
    }

    struct BlockHeader {
        bytes32 merkleRoot;
        uint target;
        uint32  timestamp;

        // PoR data
        mapping(bytes32 => Transaction) bestTx; // keccak(brand.memo) => best tx
    }

    struct Transaction {
        bytes32 id;
        bytes32 outpointTxLE;
        bytes outpointIndexLE; // 4 bytes LE integer
    }

    constructor() internal {
        return;
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

        // TODO: restrict to only recent timestamp

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

    /// @param _intermediateNodes   The proof's intermediate nodes (digests between leaf and root)
    /// @param _index               The leaf's index in the tree (0-indexed)
    function commitTx(
        bytes32 _blockHash,
        bytes calldata _intermediateNodes,
        uint _index,
        bytes calldata _vin,    // tx input vector
        bytes calldata _vout,   // tx output vector
        uint64 _version,        // tx version
        uint64 _locktime,       // tx locktime
        uint _outputIndex,
        uint _inputIndex
        // TODO: pack the 5 params in an uint256
    ) external {
        BlockHeader storage header = headers[_blockHash];
        bytes32 merkleRoot = header.merkleRoot;
        require(merkleRoot != 0, "no such block");
        // TODO: verify outdated timestamp

        bytes32 txId = ValidateSPV.calculateTxId(_version, _vin, _vout, _locktime);
        require(ValidateSPV.prove(txId, merkleRoot, _intermediateNodes, _index), "invalid merkle proof");

        // extract the brand from OP_RETURN
        bytes memory output = _vout.extractOutputAtIndex(_outputIndex);
        bytes memory memo = output.extractOpReturnData();
        require(memo.length > 0, "empty tx memo");

        // Brand memory brand = brands[tx.memo];
        // require(brand.owner != 0, "no such branch memo");
        // TODO: handle manual agent address in tx memo

        bytes memory input = _vin.extractInputAtIndex(_inputIndex);

        bytes32 memoHash = keccak256(memo);
        Transaction storage _tx = header.bestTx[memoHash];
        if (_tx.id != 0) {
            uint oldRank = txRank(_blockHash, _tx.id);
            uint newRank = txRank(_blockHash, txId);
            require(newRank < oldRank, "not better than commited tx");
        }
        // store the outpoint to claim the reward later
        _tx.outpointTxLE = input.extractInputTxIdLE();
        _tx.outpointIndexLE = input.extractTxIndexLE();
        _tx.id = txId;
    }

    function registerPKH(
        bytes memory _pubkey
    ) internal {
        address adr = CheckBitcoinSigs.accountFromPubkey(_pubkey);
        bytes20 pkh = getPKH(_pubkey);
        pkhs[pkh] = adr; // store the mapping for re-use
    }

    function getPKH(
        bytes memory _pubkey
    ) internal pure returns (bytes20 pkh) {
        return ripemd160(abi.encodePacked(sha256(_pubkey)));
    }
}
