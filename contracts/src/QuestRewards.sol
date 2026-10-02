// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Crafting} from "./Crafting.sol";
import {PackSale} from "./PackSale.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title QuestRewards
/// @notice Pays daily quest rewards: Scrap (via Crafting) and free packs (via PackSale). The referee server tracks
///         quest progress from the signed match logs and calls `reward` with a unique claim id per reward, so a
///         retried transaction can never pay twice. Per-claim caps and a global daily budget bound what a leaked
///         referee key could hand out.
contract QuestRewards is AccessControl, TestnetOnly {
    bytes32 public constant REWARDER_ROLE = keccak256("REWARDER_ROLE");

    Crafting public immutable crafting;
    PackSale public immutable packs;

    uint256 public maxScrapPerClaim = 500;
    uint256 public maxPacksPerClaim = 2;
    uint256 public dailyScrapBudget = 200_000;
    uint256 public dailyPackBudget = 1_000;

    mapping(bytes32 => bool) public claimed;
    /// @notice Spent per UTC day (block.timestamp / 1 days): Scrap and packs.
    mapping(uint256 => uint256) public scrapSpent;
    mapping(uint256 => uint256) public packsSpent;

    error AlreadyClaimed(bytes32 claimId);
    error OverClaimCap();
    error OverDailyBudget();
    error NothingToPay();

    event Rewarded(bytes32 indexed claimId, address indexed player, uint256 scrap, uint8 packKind, uint256 packCount);
    event CapsSet(
        uint256 maxScrapPerClaim, uint256 maxPacksPerClaim, uint256 dailyScrapBudget, uint256 dailyPackBudget
    );

    constructor(address admin, Crafting crafting_, PackSale packs_, address rewarder) {
        crafting = crafting_;
        packs = packs_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REWARDER_ROLE, rewarder);
    }

    function setCaps(uint256 scrapPerClaim, uint256 packsPerClaim, uint256 scrapPerDay, uint256 packsPerDay)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        (maxScrapPerClaim, maxPacksPerClaim, dailyScrapBudget, dailyPackBudget) =
        (scrapPerClaim, packsPerClaim, scrapPerDay, packsPerDay);
        emit CapsSet(scrapPerClaim, packsPerClaim, scrapPerDay, packsPerDay);
    }

    /// @notice Pays one reward: `scrap` Scrap and/or `packCount` free packs of `packKind`. Each `claimId` pays once.
    function reward(address player, bytes32 claimId, uint256 scrap, uint8 packKind, uint256 packCount)
        external
        onlyRole(REWARDER_ROLE)
    {
        if (claimed[claimId]) revert AlreadyClaimed(claimId);
        if (scrap == 0 && packCount == 0) revert NothingToPay();
        if (scrap > maxScrapPerClaim || packCount > maxPacksPerClaim) revert OverClaimCap();
        uint256 day = block.timestamp / 1 days;
        if (scrapSpent[day] + scrap > dailyScrapBudget || packsSpent[day] + packCount > dailyPackBudget) {
            revert OverDailyBudget();
        }
        claimed[claimId] = true;
        scrapSpent[day] += scrap;
        packsSpent[day] += packCount;
        if (scrap > 0) crafting.grantScrap(player, scrap);
        if (packCount > 0) packs.grantPacks(player, packKind, packCount);
        emit Rewarded(claimId, player, scrap, packKind, packCount);
    }
}
