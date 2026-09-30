// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title SeasonRewards
/// @notice End-of-season rewards. The standings are computed off-chain from MatchSettled / RatingChanged
///         events, committed as a Merkle root, and claimed by players (humans and agents alike).
contract SeasonRewards is AccessControl, TestnetOnly {
    using SafeERC20 for IERC20;

    bytes32 public constant REWARDS_ADMIN_ROLE = keccak256("REWARDS_ADMIN_ROLE");

    struct Season {
        bytes32 root;
        IERC20 token;
        uint64 claimDeadline;
    }

    mapping(uint32 => Season) public seasons;
    mapping(uint32 => mapping(address => bool)) public claimed;

    error NoSeason(uint32 season);
    error AlreadyClaimed();
    error BadProof();
    error ClaimClosed();

    event SeasonFunded(uint32 indexed season, bytes32 root, address token, uint64 claimDeadline);
    event Claimed(uint32 indexed season, address indexed player, uint256 amount);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REWARDS_ADMIN_ROLE, admin);
    }

    function publishSeason(uint32 season, bytes32 root, IERC20 token, uint64 claimDeadline)
        external
        onlyRole(REWARDS_ADMIN_ROLE)
    {
        seasons[season] = Season(root, token, claimDeadline);
        emit SeasonFunded(season, root, address(token), claimDeadline);
    }

    /// @dev Leaf = keccak256(bytes.concat(keccak256(abi.encode(player, amount)))) (OpenZeppelin standard tree).
    function claim(uint32 season, uint256 amount, bytes32[] calldata proof) external {
        Season memory s = seasons[season];
        if (s.root == bytes32(0)) revert NoSeason(season);
        if (s.claimDeadline != 0 && block.timestamp > s.claimDeadline) revert ClaimClosed();
        if (claimed[season][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, s.root, leaf)) revert BadProof();
        claimed[season][msg.sender] = true;
        s.token.safeTransfer(msg.sender, amount);
        emit Claimed(season, msg.sender, amount);
    }

    function sweep(IERC20 token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        token.safeTransfer(to, amount);
    }
}
