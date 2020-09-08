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
    uint constant EXTRA_MEMO_LENGTH = 32*4;
    // uint constant EXTRA_MINER_POS = 32*5;
    uint constant EXTRA_MERKLE_IDX  = 32*7;

    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    // using SafeMath for uint256;

    function claim(
        bytes32 _blockHash,
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
        { // stack too deep
        uint32 timestamp = header.timestamp;
        require(timestamp != 0, "no such block");
        // solium-disable-next-line security/no-block-members
        require(!_minable(timestamp), "mining time not over");
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
        bytes20 pkh = extractPKH(output, extractUint32(_extra, EXTRA_PKH_IDX));
        address miner = miners[pkh];
        require(miner != address(0x0), "unregistered PKH");
        _reward(_memoHash, miner, MAX_TARGET / uint(_blockHash).reverseUint256());
        }

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
        address payee,
        uint rewardRate
    ) internal {
        uint paid = _claimReward(memoHash, rewardRate);
        _payReward(payee, paid);    // reward the miner and upstream in the ref network
        Brand storage brand = brands[memoHash];
        emit Reward(memoHash, brand.memo.toBytes32(), brand.payer, payee, rewardRate);
    }

    /**
     * take the token from the brand (or mint for ENDURIO) to pay for miner and the network
     */
    function _claimReward(bytes32 memoHash, uint rewardRate) internal returns (uint) {
        Brand storage brand = brands[memoHash];
        address payer = brand.payer;
        if (payer == address(this)) {   // endur.io
            _mint(address(this), rewardRate);
            return rewardRate;
        }
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
    ///     uint32
    ///     uint32
    ///     uint32 EXTRA_MEMO_LENGTH
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
        Transaction storage winner = getWinner(
            header,
            _vout.extractOutputAtIndex(extractUint32(_extra, EXTRA_OUTPUT_IDX)).extractOpReturnData(),
            extractUint32(_extra, EXTRA_MEMO_LENGTH)
        );
        // TODO: handle manual miner address in tx memo

        if (winner.id != 0) {
            uint oldRank = txRank(_blockHash, winner.id);
            uint newRank = txRank(_blockHash, txId);
            // accept the same rank here to allow re-commiting the same tx to change the input index
            require(newRank <= oldRank, "better tx committed");
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
        bytes memory _pubkey    // uncompressed, unprefixed 64-bytes pubic key
    ) internal pure returns (bytes20 pkh) {
        uint8 _prefix = uint8(_pubkey[_pubkey.length - 1]) % 2 == 1 ? 3 : 2;
        bytes memory compressedPubkey = abi.encodePacked(_prefix, _pubkey.slice(0, 32));
        return ripemd160(abi.encodePacked(sha256(compressedPubkey)));
    }
}
