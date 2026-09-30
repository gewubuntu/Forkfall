// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title CardRegistry
/// @notice ERC-1155 collection for Forkfall cards. Token id `n` (1..) is the tradeable card,
///         and `STARTER_OFFSET + n` is its soulbound starter-deck twin: same card in game, never transferable.
contract CardRegistry is ERC1155, AccessControl, TestnetOnly {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant CARD_ADMIN_ROLE = keccak256("CARD_ADMIN_ROLE");

    uint256 public constant STARTER_OFFSET = 10_000;

    uint8 public constant RACE_NEUTRAL = 0;
    uint8 public constant RARITY_LEGENDARY = 3;

    struct CardInfo {
        bool exists;
        uint8 race; // 0 neutral, 1 agents, 2 prophets, 3 brokers, 4 degens
        uint8 rarity; // 0 common, 1 uncommon, 2 rare, 3 legendary
        uint8 chain; // chain of origin: 0 any, 1 base, 2 robinhood
    }

    mapping(uint256 => CardInfo) private _cards;
    mapping(uint8 => uint256[]) private _byRarity;
    uint256[] private _allIds;
    string public name = "Forkfall Cards (testnet)";
    string public symbol = "tFFCARD";

    error UnknownCard(uint256 id);
    error Soulbound(uint256 id);
    error AlreadyDefined(uint256 id);

    event CardDefined(uint256 indexed id, uint8 race, uint8 rarity, uint8 chain);

    constructor(address admin, string memory uri_) ERC1155(uri_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CARD_ADMIN_ROLE, admin);
    }

    // ─── Card definitions ───────────────────────────────────────
    function defineCards(
        uint16[] calldata ids,
        uint8[] calldata races,
        uint8[] calldata rarities,
        uint8[] calldata chains
    ) external onlyRole(CARD_ADMIN_ROLE) {
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (_cards[id].exists) revert AlreadyDefined(id);
            require(id > 0 && id < STARTER_OFFSET, "CardRegistry: id range");
            require(races[i] <= 4 && rarities[i] <= 3 && chains[i] <= 2, "CardRegistry: bad enum");
            _cards[id] = CardInfo(true, races[i], rarities[i], chains[i]);
            _byRarity[rarities[i]].push(id);
            _allIds.push(id);
            emit CardDefined(id, races[i], rarities[i], chains[i]);
        }
    }

    function setURI(string calldata uri_) external onlyRole(CARD_ADMIN_ROLE) {
        _setURI(uri_);
    }

    function cardInfo(uint256 id) public view returns (CardInfo memory c) {
        c = _cards[baseId(id)];
        if (!c.exists) revert UnknownCard(id);
    }

    function cardsOfRarity(uint8 rarity) external view returns (uint256[] memory) {
        return _byRarity[rarity];
    }

    function allCards() external view returns (uint256[] memory) {
        return _allIds;
    }

    function baseId(uint256 id) public pure returns (uint256) {
        return id >= STARTER_OFFSET ? id - STARTER_OFFSET : id;
    }

    function isStarter(uint256 id) public pure returns (bool) {
        return id >= STARTER_OFFSET;
    }

    /// @notice Copies of a card a player can put in a deck: tradeable + soulbound starter copies.
    function playableBalance(address owner, uint256 cardId) public view returns (uint256) {
        return balanceOf(owner, cardId) + balanceOf(owner, cardId + STARTER_OFFSET);
    }

    // ─── Mint / burn (PackSale, StarterDecks, Crafting) ─────────
    function mint(address to, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (!_cards[baseId(id)].exists) revert UnknownCard(id);
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external onlyRole(MINTER_ROLE) {
        for (uint256 i; i < ids.length; ++i) {
            if (!_cards[baseId(ids[i])].exists) revert UnknownCard(ids[i]);
        }
        _mintBatch(to, ids, amounts, "");
    }

    function burnFrom(address from, uint256 id, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, id, amount);
    }

    // ─── Soulbound starters ─────────────────────────────────────
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0)) {
            for (uint256 i; i < ids.length; ++i) {
                if (isStarter(ids[i])) revert Soulbound(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
