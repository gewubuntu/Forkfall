// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CardRegistry} from "./CardRegistry.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title Crafting
/// @notice Burn duplicate tradeable cards for Scrap, spend Scrap to craft any card. The main sink.
///         Soulbound starter copies cannot be scrapped (they would otherwise be a free Scrap farm).
///         Foils come only from packs: they can't be crafted, and scrap for `FOIL_SCRAP_MULTIPLIER` times the value.
contract Crafting is TestnetOnly {
    CardRegistry public immutable cards;
    mapping(address => uint256) public scrap;

    // Per rarity: common, uncommon, rare, legendary
    uint256[4] public scrapValue = [uint256(5), 20, 100, 400];
    uint256[4] public craftCost = [uint256(40), 100, 400, 1600];

    uint256 public constant FOIL_SCRAP_MULTIPLIER = 4;

    error StarterNotScrappable(uint256 id);
    error FoilNotCraftable(uint256 id);
    error NotEnoughScrap(uint256 have, uint256 need);

    event Scrapped(address indexed player, uint256 indexed id, uint256 amount, uint256 scrapGained);
    event Crafted(address indexed player, uint256 indexed id, uint256 scrapSpent);

    constructor(CardRegistry cards_) {
        cards = cards_;
    }

    function scrapCards(uint256[] calldata ids, uint256[] calldata amounts) external {
        uint256 gained;
        for (uint256 i; i < ids.length; ++i) {
            if (cards.isStarter(ids[i])) revert StarterNotScrappable(ids[i]);
            uint256 v = scrapValue[cards.cardInfo(ids[i]).rarity] * amounts[i]
                * (cards.isFoil(ids[i]) ? FOIL_SCRAP_MULTIPLIER : 1);
            cards.burnFrom(msg.sender, ids[i], amounts[i]);
            gained += v;
            emit Scrapped(msg.sender, ids[i], amounts[i], v);
        }
        scrap[msg.sender] += gained;
    }

    function craft(uint256 id) external {
        if (cards.isStarter(id)) revert StarterNotScrappable(id);
        if (cards.isFoil(id)) revert FoilNotCraftable(id);
        uint256 cost = craftCost[cards.cardInfo(id).rarity];
        uint256 have = scrap[msg.sender];
        if (have < cost) revert NotEnoughScrap(have, cost);
        scrap[msg.sender] = have - cost;
        cards.mint(msg.sender, id, 1);
        emit Crafted(msg.sender, id, cost);
    }
}
