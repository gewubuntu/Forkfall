// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title TestnetOnly
/// @notice Every Forkfall MVP contract refuses to deploy outside an allowlisted test network.
///         Mainnet launch is gated by the GDD's security and legal gates, not by this codebase.
abstract contract TestnetOnly {
    error MainnetNotAllowed(uint256 chainId);

    uint256 internal constant ANVIL = 31337;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant ROBINHOOD_TESTNET = 46630;
    uint256 internal constant ETH_SEPOLIA = 11155111;

    constructor() {
        if (!isTestnet(block.chainid)) revert MainnetNotAllowed(block.chainid);
    }

    function isTestnet(uint256 id) public pure returns (bool) {
        return id == ANVIL || id == BASE_SEPOLIA || id == ROBINHOOD_TESTNET || id == ETH_SEPOLIA;
    }
}
