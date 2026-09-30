// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CardRegistry} from "./CardRegistry.sol";
import {Set1Cards} from "./generated/Set1Cards.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title StarterDecks
/// @notice Free, soulbound 30-card starter deck per race. Nobody has to pay to play,
///         and soulbound copies cannot be sold or farmed.
contract StarterDecks is TestnetOnly {
    CardRegistry public immutable cards;
    mapping(address => mapping(uint8 => bool)) public claimed;

    error AlreadyClaimed(address player, uint8 race);
    error BadRace(uint8 race);

    event StarterClaimed(address indexed player, uint8 indexed race);

    constructor(CardRegistry cards_) {
        cards = cards_;
    }

    function claim(uint8 race) external {
        _claim(msg.sender, race);
    }

    function _claim(address player, uint8 race) internal {
        if (race == 0 || race > 4) revert BadRace(race);
        if (claimed[player][race]) revert AlreadyClaimed(player, race);
        claimed[player][race] = true;

        uint16[30] memory deck = Set1Cards.starter(race);
        // Starter lists are sorted pairs (2 copies each), so collapse into (id, 2) entries.
        uint256[] memory ids = new uint256[](15);
        uint256[] memory amounts = new uint256[](15);
        uint256 n;
        for (uint256 i; i < 30; ++i) {
            uint256 id = uint256(deck[i]) + cards.STARTER_OFFSET();
            if (n > 0 && ids[n - 1] == id) {
                amounts[n - 1] += 1;
            } else {
                ids[n] = id;
                amounts[n] = 1;
                ++n;
            }
        }
        assembly {
            mstore(ids, n)
            mstore(amounts, n)
        }
        cards.mintBatch(player, ids, amounts);
        emit StarterClaimed(player, race);
    }

    function starterList(uint8 race) external pure returns (uint16[30] memory) {
        return Set1Cards.starter(race);
    }
}
