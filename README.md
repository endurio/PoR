# Endurio: Proof of Reference

Every Bitcoin transaction can be sent with memo text in an OP_RET output. This memo can be used to promote user brand in everyday transactions.

The Endurio Protocol is designed to create an incentive for Bitcoin users to include a small memo into their everyday transactions to promote any brand paid in the market.

## Table of Contents
- [END - The Crypto Token](#end---the-crypto-token)
- [Proof of Reference](#proof-of-reference)
  * [Mining](#mining)
  * [Relaying](#relaying)
  * [Transaction Ranking](#transaction-ranking)
  * [Claiming](#claiming)
  * [Reward](#reward)
  * [Development Vault](#development-vault)
  * [Multiple Brands Mining](#multiple-brands-mining)
- [Brand Market](#brand-market)
  * [Brand Campaign](#brand-campaign)
- [Referral Network](#referral-network)
  * [Network Rent](#network-rent)
    + [Rent Upgrade](#rent-upgrade)
    + [Quick Rent Escalation](#quick-rent-escalation)
    + [Inactive Rent Decay](#inactive-rent-decay)
  * [Commission Distribution](#commission-distribution)
  * [Commission Cutback](#commission-cutback)
  * [Global Configs](#global-configs)
- [Advanced Mining](#advanced-mining)
  * [X-Mining](#x-mining)
  * [Bounty Hunting](#bounty-hunting)
    + [Bounty Amount](#bounty-amount)
    + [Bounty Recipient](#bounty-recipient)
    + [Bounty Reward](#bounty-reward)
- [API](#api)
  * [Proof of Reference](#proof-of-reference-1)
  * [Brand Market](#brand-market-1)
  * [Referral Network](#referral-network-1)
- [Compatibility](#compatibility)
- [Appendix A: Commission Distribution](#appendix-a--commission-distribution)

## END - The Crypto Token
Endcoin (END) is the crypto token of the Endurio Protocol.

* END's initial supply is ZERO. No token is pre-mined.
* END is freshly minted only by successful [mining](#mining) `endur.io`
* In the [Brand Market](#brand-market):
	* END is required to fund *user brand* campaign
	* END is paid by campaigns to the miners mining *user brand*
* In the [Referral Network](#referral-network):
	* END is burnt to pay for rent.
	* END is paid as a commission for each successful mining.

## Proof of Reference
### Mining
To mine *SomeBrand* is to:
1. send a Bitcoin transaction with the first OP_RET data begins with *"SomeBrand"*, and wait for a confirmation,
2. relay that transaction to the Endurio contract on the Ethereum network.

![mining transaction](https://raw.githubusercontent.com/endurio/media/main/btc-tx-mining.svg?sanitize=true)

If there is more than one transaction mining the same band in a block, only one can be claimed. The single successful mining transaction is randomly selected using the block's hash and transaction ID as entropies.

### Relaying
To relay is to provide cryptographic proofs that a mining transaction is confirmed in a valid PoW block. Instead of full relaying, Endurio opts for quasi-relaying that accepts orphaned blocks and blocks that don't belong to any chain.

The mining transaction must be relayed no later than **one hour** after the target block's timestamp or the reward is lost forever.

### Transaction Ranking
The ranking of the mining transaction is randomly calculated using the target block hash and the transaction id itself.

$Rank = \text{KECCAK256}(BlockHash_{BE}+TxID_{LE}) \div 2^{224}$

$BlockHash$ is the hash of the Bitcoin block where the mining transaction is confirmed in the big-endian format.

If there is more than one tx mining the same brand in a block, only the one submitted with the lowest $Rank$ value can be claimed. During the relaying time, any transaction can be submitted to challenge the previously one of the same brand, the one with the higher $Rank$ value will be discarded.

### Claiming
After the relaying time is over, the last relayed transaction can be claimed anytime by the miner. The miner is the Ethereum account that shares the same key pair with the sender address of the mining transaction.

For example, any transactions sent by `tb1q49239d5pwn63cqhmnnfgu8z6ndzah7dycgcfql` can be claimed by its miner address `0x2222A917A5Fc6A35166346c69402f5677Ce51205` because they belong to the same public key:
```
a56048b4f7a81655366a09592a1ab9921df35fa8f2d0a6a9a298627e90f8255d
a5b1f3f8887bbab53d13b8fd4a4fe7426012e6a11d35fd1e18377ad3b87e4609
```

### Reward
The reward paid for a mining transaction is calculated based on the block's $Target$ and $PayRate$ of the mining *brand*.

$Reward = \dfrac{2^{240} \times PayRate}{Target}$

The $PayRate* of the system brand *endur.io* is 1.0.
The $PayRate* of *user brand* is set by the campaign owner in the [Brand Market].

At the time of writing, mining `endur.io` in a Bitcoin transaction earns miner roughly 1.3 END tokens.

### Development Vault
For each reward claimed, there's a 1/32 chance that an additional subsidy of the same amount goes to the **Development Vault** (~3% mining reward).

The **Development Vault** reward condition is cryptographically randomized as follow:
$\text{KECCAK256}(\text{KECCAK256}(memo)+BlockHash) \% 32 = 0$

### Multiple Brands Mining
Multiple brands can be mined in a block, each brand has at most one transaction rewarded for a block. Transactions mining different brands don't compete with each other.

## Brand Market
Brand Market is a decentralized market to offer payment to **user brand** miners via **brand campaign**.
* The *system brand* *endur.io* is paid by the protocol with freshly minted END tokens.
* Mining *user brand* will not generate any new END token but taking END tokens from the campaign fund.

### Brand Campaign
A brand campaign is created in the Brand Market to offer END token payment for mining a *user brand*.

A campaign is identified by the brand *memo* and *owner* (or *payer*) so the same *memo* can be paid by multiple payers via multiple brand campaigns. (See [Design Rationale])

A campaign has:
* memo: the UTF-8 text to mine
* payer: the owner of the campaign
* fund: END tokens amount locked by the owner to pay miners
* payRate: payment rate for each successful mining transaction
* expiration: expiration date

The *campaign* is deactivated when either:
* the expiration is reached
* all the fund is spent

An expired campaign can be manually deactivated by its owner and all the remaining locked END is refunded.

An unexpired campaign can only be upgraded to either:
* increase the *pay rate*
* extending the expiration
* add more fund

## Referral Network
RefNet is a referral marketing network represented as a forest data structure.

Each node can refer to a parent node. A node with no parent is a root node. The parent node reference can be changed or removed anytime by the children node.

For each mining reward is claimed without [development vault](#development-vault) subsidy, there's at most 1 additional commission is paid for one of the nodes in the [referral chain] of the miner.

### Network Rent
Anyone can join the referral network, but nodes must pay rent to have a chance of receiving commission from descendant nodes mining reward. Rent is paid by burning END tokens via the Referral Network API.

* The higher the rent is, the higher the chance a node will receive commissions.
* The closer the node to the miner in accumulative rent, the higher the chance of receiving commissions.

Decreasing rent can be done anytime and free of charge. Increasing rent requires fee and time restrictions. There are two ways to increase the rent: slow upgrade and quick escalate.

#### Rent Upgrade
Conditions:
* After 1 week from the last rent upgrade or escalate.
* New rent is no higher than 2 times of old rent.

$UpgradeFee = (NewRent - OldRent) \times 302400$

Note: 302400 is half a week in seconds.

#### Quick Rent Escalation
If the upgrade condition is not met, rent can be quickly escalated by paying 3 times the upgrade fee.

$EscalateFee =UpgradeFee  \times 3$

The first rent setup for an uninitialized node is always an escalation.

#### Inactive Rent Decay
An inactive/expired node will have its rent decayed overtime. This decayed rent will be used as the *current rent* when the node is reactivated.

If a node with rent $r$ is inactive for $T$ week(s), its decaying rent will be closed to $\dfrac r {2^T}$. Technically, it is implemented as ${\dfrac r {2^{\lfloor{T}\rfloor}}} (1-\dfrac{\{T\}}2)$ to avoid floating point calculation.

### Commission Distribution
When a $Reward$ is claimed by miner $M$, one of the nodes in the referral chain is paid a commission of $Reward \times ComRate$.

The chance of receiving commission for each node is proportional to their area in the following graph, where the miner is node $0$ and node $i+1$ is the parent of node $i$.

![referral chances graph](https://raw.githubusercontent.com/endurio/media/main/graph-referral-chances.png)

The curve is $f(x) = (\frac 1 2)^x$, with $r_i$ is the effective rent of node $i$ and $x_i = \sum_0^i{r_i \over RentScale}$, we have:
$$S_i=\int_{x_{i-1}}^{x_i}f(x)dx$$
Since the whole area under the curve is $S = \int_0^\infty f(x)dx = \dfrac{1}{ln(2)}$, the chance of receiving commission for node $i$ is $\dfrac{S_i}S = S_i \times ln(2)$.

There's always a chance that no node will receive the commission, which is represented by the blank area after the last node of the referral chain $S_3$.

See [Appendix A] for the commission distribution implementation.

### Commission Cutback
Commission cutback provides the incentive for the miner to join the referral network. The cutback is paid by the commission receiver to the miner when a commission is paid.

Cutback can be paid using native END token, external ERC20 token, or contract logic. The external token interface requires the only method `transferFrom(address,address,uint)` borrowed from the ERC20 interface. Custom cutback logic can be freely implemented by each sub-network to apply any complex management policies.

The cutback token and rate is configured by each node. The external contract call to custom cutback can be failed or not beneficial for the miner, so the commission can be skipped entirely when the cutback is undesirable.

### Global Configs
There are 2 global params for commission distribution, both are currently controlled by the Endurio developer:
* **ComRate**: the rate of commission to mining reward, initially set at 0.5. The  value range is $[0;4.294967295]$.
* **RentScale**: how much accumulate rent from the miner up the referral chain until the commission chance is halved. The higher the value, the more commission is distributed up the referral chain. Initially set at $1000$. Value range is $[0;2^{224})$.

## Advanced Mining

### X-Mining
If quasi-relaying a Bitcoin transaction to Ethereum is costlier than the reward, or the transaction is mined in some alt-chain with very little reward, miners can opt for x-mining to increase the reward by decreasing the winning chance proportionally.

To x-mine a brand, the brand memo (in OP_RET) is appended with one space character (ASCII 0x20), an `x`, and the decimal string of reward multiplier number `m`.

    OP_RET "endur.io x6"

An x-mining transaction is valid only in a block with $m\times BlockHash \le Target$ and the reward will be $m \times Reward$.

### Bounty Hunting
<!--
Brand mining and x-mining are designed to be cost-effective for everyday transactions by using only a dozen of bytes more for additional OP_RET output.
-->

Bounty hunting is to mine a brand and sending some random recent transactors a *useful amount of coin*.

![bounty hunting transaction](https://raw.githubusercontent.com/endurio/media/main/btc-tx-mining-bounty.svg?sanity=true)

Bounty outputs are all outputs after the first OP_RET except the last one (reserved for coin change). A transaction can have up to 8 bounty outputs, but only one of the bounty output is randomly sampled for verification.

The index of sampling bounty output in the bounty outputs array is $BlockHash\%N$ where $N$ is the number of the bounty outputs.

#### Bounty Amount
In Bitcoin, a dust output will be ignored by wallets and recipients because it's not beneficial to spend an amount too small. In bounty hunting transaction, miner makes them an offer they can't refuse.

A useful amount is an amount large enough to pay the fee of the transaction to spend that output. The transaction fee is calculated by the mining transaction itself.

$MinTxSize = 10+FirstInputSize+BountyOutputSize$

$UsefulAmount = \dfrac{MinTxSize}{TxSize} \times TxFee$

All bounty outputs value must be no less than $UsefulAmount$ regardless of which is sampled to be verified.

#### Bounty Recipient
Bounty recipient must be the recipient address of the last output (usually the coin change address) of a transaction in a recent block and

A recent block is a block with a timestamp no earlier than 1 hour from the mining block. The reward is calculated by the lower difficulty of the recent block and the mining block.

To make the bounty recipients different for each miner, the recent transaction is eligible for bounty output of a mining transaction must also have this condition fulfilled:

$\text{KECCAK256}(FirstOutpointID+BountyTxID) \% 32 = 0$
* FirstOutputID is the first input outpoint ID (LE) of the mining transaction
* BountyTxID is the recent transaction ID (LE)

#### Bounty Reward
$$BountyReward=\dfrac{2n\times2^{240} \times PayRate}{max(Target, BountyTarget)}$$
With $n$ is the number of bounty outputs and $BountyTarget$ is the block target of the sampled bounty recipient transaction.

## API

### Proof of Reference
Proof of Reference is cryptographic proofs of a mining transaction being included in a valid PoW block.

#### `submit(ParamSubmit, ParamOutpoint[], ParamBounty[])`
**ParamSubmit** is a mandatory structure with:
* payer (address): the payer/owner of the brand campaign
* header (bytes): the Bitcoin block header byte array
* merkleIndex (uint32): the Merkle index of the mining transaction in the block
* merkleProof (bytes): the Merkle proof of the mining transaction in the block
* version (uint32): 4 bytes of transaction version 
* locktime (uint32): 4 bytes of transaction locktime
* vin (bytes): transaction inputs byte array
* vout (bytes): transaction outputs byte array
* inputIndex (uint32): the index of the miner input
* memoLength (uint32): optional memo length for x-mining or prepending user memo after the mining brand
* pubkeyPos (uint32): (optional) position of the 33 bytes compressed pubkey in the miner input byte array

**ParamOutpoint** is a structure with:
* version, locktime, vin, and vout of the outpoint transaction
* pkhPos (uint32): (optional) position of miner PKH in the outpoint output bytes, including the first 8-bytes value

**ParamOutput[]** is an array of required outpoints for the transaction inputs.
* In the P2WPKH transaction, only the outpoint of the miner input is required.
* In bounty mining, outpoints for all miner inputs are required in the same order.
* All other cases, the ParamOutput is not required

**ParamBounty** is an optional structure param with:
* header, merkleIndex, and merkleProof of the sampling bounty recipient transaction block
* version, locktime, vin, and vout of the sampling bounty recipient transaction

#####  event `Submit(blockHash, memoHash, payer, pubkey, amount, timestamp)`
Upon successful `submit`,  the `Mined` event is emitted with useful information for `claim` params later.

#### `claim(ParamClaim)`
**ParamClaim** is the structure params with:
* blockHash (bytes32): of the mining transaction
* memoHash (bytes32): brand memo hash
* payer (address): brand campaign payer for user brand campaign
* isPKH (bool): whether the mining transaction contains PKH instead of compressed PK
* skipCommission (bool): option to skip the commission distribution and cutback
* pubX (bytes32): the first 32 of 64 bytes of miner public key
* pubY (uint): the last 32 of 64 bytes of miner public key
* amount (uint): the pre-committed reward amount
* timestamp (uint); the pre-committed timestamp of the mining block

The following params can be extracted directly from the `Mined` event emitted by the `submit` transaction: blockHash, memoHash, payer, amount, timestamp, and isPKH. isPKH is `true` if the first 12 bytes of `Submit.pubkey` are zeros.

### Brand Market

#### `activate(memo, fund, payRate, duration)`
Active, fund, and change the pay rate of a brand campaign.
* memo (bytes): the brand memo
* fund (uint): (optional) amount of END to fund the campaign
* payRate (uint): optional new pay rate (decimals 18)
* duration (uint): optional new duration from the confirmation block time before the campaign is expired

If the brand is uninitialized or expired, both fund and payRate are required, default duration is 2 weeks if zero is passed.

If the brand is active, any or none of the 3 optional params can be provided.

#####  event `Active(memoHash, payer, memo, payRate, balance, expiration)`

#### `deactivate(memoHash)`
Deactivate the brand and withdraw any remaining funds.
#####  event `Deactive(memoHash, payer)`

#### `queryCampaign(memoHash, payer)`

### Referral Network
#### `attach(address parent)`
Set an address as the parent node.
#### `query(address)`
Query the node details of and address.
#### `update(int fund, uint newRent, bool escalate)`
Update the node settings:
* fund (int): optional fund to deposit or withdraw, 
* newRent (uint): optional new rent value
* escalate (bool): a consent flag for rent escalation

Passing negative `fund` value to withdraw from the node balance. Over withdrawing will not be reverted, but empty the remaining balance instead.

If the node is uninitialized, both `fund` and `newRent` are mandatory.

The node balance is always divisible by active rent, so some of the balance will be lost due to the rounding on each call to `update`. Pre-calculation can help minimize the value lost.

#### `setCutbackRate(address token, uint rate, uint decimals)`
Set the cutback option for this node:
* token (address): ERC20 token address to use for cutback, 0x0 to use the native END token for cutback
* rate (uint): cutback rate
* decimals (uint): decimals of cutback rate in case of non-native token

Native END cutback:
* token must be 0x0
* decimals is ignored, fixed with 9
* rate value range is $[0;10^9]$
* $CutbackRate = \dfrac{rate}{10^9}$

Custom token cutback:
* token must not be 0x0
* decimals value range is $[0; 255]$
* rate value range is $[0; 2^{88})$
* $CutbackRate = \dfrac{rate}{10^{decimals}}$

The END token is an ERC20, so it's valid to set a custom token cutback using the END token address.

## Compatibility
The Proof of Reference is originally designed for Bitcoin as the target mining protocol and optimized to be relayed to Ethereum EVM as the host smart-contract platform. It could work with other protocols of the same family, and more target protocols will be supported in the future.

## Appendix A: Commission Distribution
