// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CardRegistry} from "./CardRegistry.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title DeckRegistry
/// @notice Players register 30-card decks on the hub. Rules mirror the engine: one race plus neutrals,
///         max 2 copies (1 per Legendary), and for ranked a rarity budget so money buys breadth, not power.
///         Ownership is re-checked live at settlement time, so selling a card invalidates the deck.
contract DeckRegistry is TestnetOnly {
    uint256 public constant DECK_SIZE = 30;
    uint256 public constant RANKED_RARITY_CAP = 18;
    uint256 public constant MAX_LEGENDARIES_RANKED = 1;

    CardRegistry public immutable cards;

    struct Deck {
        address owner;
        uint8 race;
        uint16 rarityPoints;
        uint8 legendaries;
        uint16[] cardIds; // sorted ascending
    }

    mapping(bytes32 => Deck) private _decks;
    mapping(address => bytes32[]) private _byOwner;

    error BadSize(uint256 n);
    error NotSorted();
    error BadRace(uint8 race);
    error WrongRace(uint256 cardId);
    error TooManyCopies(uint256 cardId);
    error NotOwned(uint256 cardId, uint256 have, uint256 need);

    event DeckRegistered(
        bytes32 indexed deckId, address indexed owner, uint8 race, uint16 rarityPoints, bool rankedLegal
    );

    constructor(CardRegistry cards_) {
        cards = cards_;
    }

    function deckIdOf(address owner, uint8 race, uint16[] calldata ids) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, race, ids));
    }

    /// @param ids 30 base card ids (1..), sorted ascending. Starter (soulbound) copies count toward ownership.
    function register(uint8 race, uint16[] calldata ids) external returns (bytes32 deckId) {
        if (race == 0 || race > 4) revert BadRace(race);
        if (ids.length != DECK_SIZE) revert BadSize(ids.length);
        uint256 points;
        uint256 legendaries;
        uint256 run;
        for (uint256 i; i < ids.length; ++i) {
            if (i > 0 && ids[i] < ids[i - 1]) revert NotSorted();
            CardRegistry.CardInfo memory c = cards.cardInfo(ids[i]);
            require(!cards.isStarter(ids[i]), "DeckRegistry: use base ids");
            if (c.race != 0 && c.race != race) revert WrongRace(ids[i]);
            run = (i > 0 && ids[i] == ids[i - 1]) ? run + 1 : 1;
            uint256 maxCopies = c.rarity == 3 ? 1 : 2;
            if (run > maxCopies) revert TooManyCopies(ids[i]);
            bool lastOfRun = i + 1 == ids.length || ids[i + 1] != ids[i];
            if (lastOfRun) {
                uint256 have = cards.playableBalance(msg.sender, ids[i]);
                if (have < run) revert NotOwned(ids[i], have, run);
            }
            points += c.rarity == 0 ? 0 : c.rarity == 1 ? 1 : c.rarity == 2 ? 2 : 4;
            if (c.rarity == 3) ++legendaries;
        }
        deckId = keccak256(abi.encode(msg.sender, race, ids));
        if (_decks[deckId].owner == address(0)) _byOwner[msg.sender].push(deckId);
        _decks[deckId] = Deck(msg.sender, race, uint16(points), uint8(legendaries), ids);
        emit DeckRegistered(deckId, msg.sender, race, uint16(points), _rankedLegal(uint16(points), uint8(legendaries)));
    }

    function _rankedLegal(uint16 points, uint8 legendaries) internal pure returns (bool) {
        return points <= RANKED_RARITY_CAP && legendaries <= MAX_LEGENDARIES_RANKED;
    }

    function getDeck(bytes32 deckId) external view returns (Deck memory) {
        return _decks[deckId];
    }

    function decksOf(address owner) external view returns (bytes32[] memory) {
        return _byOwner[owner];
    }

    /// @notice Is `deckId` owned by `player` right now, still fully backed by cards, and (optionally) ranked-legal?
    function isValidFor(bytes32 deckId, address player, bool ranked) external view returns (bool) {
        Deck storage d = _decks[deckId];
        if (d.owner != player || d.owner == address(0)) return false;
        if (ranked && !_rankedLegal(d.rarityPoints, d.legendaries)) return false;
        uint16[] storage ids = d.cardIds;
        uint256 run;
        for (uint256 i; i < ids.length; ++i) {
            run = (i > 0 && ids[i] == ids[i - 1]) ? run + 1 : 1;
            if ((i + 1 == ids.length || ids[i + 1] != ids[i]) && cards.playableBalance(player, ids[i]) < run) {
                return false;
            }
        }
        return true;
    }
}
