// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2;

import {BytesLib} from "./lib/bitcoin-spv/contracts/BytesLib.sol";
import {BTCUtils} from "./lib/bitcoin-spv/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "./lib/bitcoin-spv/contracts/CheckBitcoinSigs.sol";
import {ValidateSPV} from "./lib/bitcoin-spv/contracts/ValidateSPV.sol";
import {util} from "./lib/util.sol";
import {BrandMarket} from "./BrandMarket.sol";

/**
 * Proof of Reference
 */
contract PoR is BrandMarket {
    uint constant COMMIT_TIMEOUT = 10 minutes;

    uint constant MAX_TARGET = 0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;

    // extra param bit posistion (from the right)
    uint constant EXTRA_VERSION     = 0;
    uint constant EXTRA_LOCKTIME    = 32;
    uint constant EXTRA_PKH_IDX     = 32*2;
    uint constant EXTRA_OUTPUT_IDX  = 32*2;
    uint constant EXTRA_INPUT_IDX   = 32*3;
    uint constant EXTRA_MEMO_LENGTH = 32*4;
    // uint constant EXTRA_MINER_POS = 32*5;

    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    // using SafeMath for uint256;

    mapping(bytes20 => address) internal miners; // pubkey bytes32 => address
    mapping(bytes32 => Header) internal headers;

    struct Header {
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

    constructor() public BrandMarket() {
    }

    function mine(
        bytes32 _blockHash,
        bytes32 _memoHash,
        bytes calldata _vin,    // outpoint tx input vector
        bytes calldata _vout,   // outpoint tx output vector
        uint _extra
            // uint32 _pkhIdx,      // (optional) position of miner PKH in the outpoint raw data
                                    // (including the first 8-bytes amount for optimization)
            // uint32 _locktime,    // tx locktime
            // uint32 _version,     // tx version
    ) external {
        Header storage header = headers[_blockHash];
        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        // solium-disable-next-line security/no-block-members
        require(timestamp <= block.timestamp - COMMIT_TIMEOUT, "block too new");
        }

        Transaction storage winner = header.winner[_memoHash];
        require(winner.id != 0, "no such tx");

        { // stack too deep
        bytes32 txId = ValidateSPV.calculateTxId(
            extractUint32(_extra, EXTRA_VERSION),
            _vin,
            _vout,
            extractUint32(_extra, EXTRA_LOCKTIME));
        // TODO: endianness
        require(winner.outpointTxLE == txId, "outpoint tx mismatch");
        }

        { // stack too deep
        bytes memory output = _vout.extractOutputAtIndex(winner.outpointIndexLE.reverseEndianness().toUint32(0));
        address miner = miners[extractPKH(output, extractUint32(_extra, EXTRA_PKH_IDX))];
        require(miner != address(0x0), "unregistered PKH");
        pay(_memoHash, miner, MAX_TARGET / header.target);
        }

        delete header.winner[_memoHash];

        if (header.minable > 1) {
            header.minable--;
        } else {
            delete headers[_blockHash];

            // TODO: clean up and rate adjustment here
        }
    }

    function extractPKH(
        bytes memory _output,
        uint32 _pkhIdx
    ) internal pure returns (bytes20) {
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
        uint _merkleIndex,
        uint _extra,
            // uint32 _memoLength
            // uint32 _inputIndex     // index of input which its outpoint locking script contains the miner PKH
            // uint32 _outputIndex,
            // uint32 _locktime,      // tx locktime
            // uint32 _version,       // tx version
        bytes calldata _vin,    // tx input vector
        bytes calldata _vout   // tx output vector
    ) external {
        Header storage header = headers[_blockHash];

        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        // solium-disable-next-line security/no-block-members
        require(block.timestamp - COMMIT_TIMEOUT < timestamp, "block too old");
        }

        bytes32 txId = ValidateSPV.calculateTxId(
            extractUint32(_extra, EXTRA_VERSION),
            _vin,
            _vout,
            extractUint32(_extra, EXTRA_LOCKTIME));
        require(ValidateSPV.prove(txId, header.merkleRoot, _merkleProof, _merkleIndex), "invalid merkle proof");

        // extract the brand from OP_RETURN
        Transaction storage winner = getWinner(
            header,
            _vout.extractOutputAtIndex(extractUint32(_extra, EXTRA_OUTPUT_IDX)).extractOpReturnData(),
            extractUint32(_extra, EXTRA_MEMO_LENGTH)
        );
        // TODO: handle manual miner address in tx memo

        if (winner.id != 0) {
            uint oldRank = txRank(_blockHash, winner.id);
            uint newRank = txRank(_blockHash, txId);
            require(newRank < oldRank, "not better than commited tx");
        } else {
            header.minable++; // increase the ref count for new brand
        }

        // store the outpoint to claim the reward later
        bytes memory input = _vin.extractInputAtIndex(extractUint32(_extra, EXTRA_INPUT_IDX));
        winner.outpointTxLE = input.extractInputTxIdLE();
        winner.outpointIndexLE = input.extractTxIndexLE();
        winner.id = txId;
    }

    function getWinner(
        Header storage header,
        bytes memory opret,
        uint memoLength
    ) internal view returns (Transaction storage) {
        require(opret.length > memoLength, "no memo in tx opret");
        bytes memory memo = memoLength > 0 ? opret.slice(0, memoLength) : opret;
        // unregistered brand allowed here
        bytes32 memoHash = keccak256(memo);
        return header.winner[memoHash];
    }

    function extractUint32(uint packed, uint shift) internal pure returns (uint32) {
        return uint32((packed >> shift) & 0xFFFFFFFF);
    }

    /// TODO: create an incentive for only 1 miner to commit the block
    function commitBlock(
        bytes calldata _header
    ) external {
        bytes32 _blockHash = _header.hash256();
        Header storage header = headers[_blockHash];
        require(header.merkleRoot == 0, "block committed");

        // header can be of any size
        uint target = _header.extractTarget();
        // Require that the header has sufficient work
        require(uint(_blockHash).reverseUint256() <= target, "insufficient work");

        // TODO: verify block timestamp > genesis timestamp

        header.merkleRoot = _header.extractMerkleRootLE().toBytes32();
        header.timestamp = _header.extractTimestamp();
        header.target = target;
    }

    function txRank(bytes32 blockHash, bytes32 txHash) internal pure returns (uint) {
        return uint(keccak256(abi.encodePacked(blockHash, txHash)));
    }

    function registerMiner(
        bytes calldata _pubkey,
        address _beneficient    // (optional) rewarding address
    ) external {
        address adr = CheckBitcoinSigs.accountFromPubkey(_pubkey);
        if (_beneficient != address(0x0)) {
            require(msg.sender == adr, "only pkh owner can change the beneficient address");
            adr = _beneficient;
        }
        bytes20 pkh = getPKH(_pubkey);
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
        bytes memory _pubkey
    ) internal pure returns (bytes20 pkh) {
        return ripemd160(abi.encodePacked(sha256(_pubkey)));
    }
}
