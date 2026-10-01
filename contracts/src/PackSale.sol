// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CardRegistry} from "./CardRegistry.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title PackSale
/// @notice Sells 5-card Set 1 packs for ETH or an allowlisted ERC-20 (test USDC, test game token).
///         Pack: 3 Common, 1 Uncommon, 1 Rare that upgrades to Legendary ~1 in 10.
/// @dev Testnet randomness is two-step commit/blockhash: buying commits to a future block, opening
///      reads that block's hash. Good enough for testnet; the GDD requires VRF before mainnet beta.
contract PackSale is AccessControl, ReentrancyGuard, TestnetOnly {
    using SafeERC20 for IERC20;

    bytes32 public constant PRICE_ADMIN_ROLE = keccak256("PRICE_ADMIN_ROLE");

    uint256 public constant CARDS_PER_PACK = 5;
    uint256 public constant LEGENDARY_UPGRADE_BPS = 1_000; // 10%
    uint256 public constant MAX_PACKS_PER_TX = 10;
    uint256 public constant REVEAL_DELAY = 2;

    CardRegistry public immutable cards;
    address payable public treasury;
    uint256 public ethPrice;
    mapping(address => uint256) public tokenPrice; // 0 = not accepted

    struct Pack {
        address owner;
        uint64 revealBlock;
        bool opened;
    }

    Pack[] public packs;
    mapping(address => uint256[]) private _packsOf;

    error BadCount();
    error WrongPayment();
    error TokenNotAccepted(address token);
    error NotOwner();
    error AlreadyOpened();
    error TooEarly(uint256 revealBlock);

    event PacksBought(address indexed buyer, uint256 firstPackId, uint256 count, address payToken, uint256 paid);
    event PackOpened(uint256 indexed packId, address indexed owner, uint256[5] cardIds);
    event PackRecommitted(uint256 indexed packId, uint64 revealBlock);

    constructor(CardRegistry cards_, address admin, address payable treasury_, uint256 ethPrice_) {
        cards = cards_;
        treasury = treasury_;
        ethPrice = ethPrice_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICE_ADMIN_ROLE, admin);
    }

    // ─── Admin ──────────────────────────────────────────────────
    function setEthPrice(uint256 p) external onlyRole(PRICE_ADMIN_ROLE) {
        ethPrice = p;
    }

    function setTokenPrice(address token, uint256 p) external onlyRole(PRICE_ADMIN_ROLE) {
        tokenPrice[token] = p;
    }

    function setTreasury(address payable t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = t;
    }

    // ─── Buy ────────────────────────────────────────────────────
    function buyWithEth(uint256 count) external payable nonReentrant returns (uint256 firstId) {
        if (count == 0 || count > MAX_PACKS_PER_TX) revert BadCount();
        if (ethPrice == 0 || msg.value != ethPrice * count) revert WrongPayment();
        firstId = _commit(msg.sender, count);
        (bool ok,) = treasury.call{value: msg.value}("");
        require(ok, "PackSale: treasury transfer failed");
        emit PacksBought(msg.sender, firstId, count, address(0), msg.value);
    }

    function buyWithToken(address token, uint256 count) external nonReentrant returns (uint256 firstId) {
        if (count == 0 || count > MAX_PACKS_PER_TX) revert BadCount();
        uint256 price = tokenPrice[token];
        if (price == 0) revert TokenNotAccepted(token);
        IERC20(token).safeTransferFrom(msg.sender, treasury, price * count);
        firstId = _commit(msg.sender, count);
        emit PacksBought(msg.sender, firstId, count, token, price * count);
    }

    function _commit(address buyer, uint256 count) internal returns (uint256 firstId) {
        firstId = packs.length;
        uint64 reveal = uint64(block.number + REVEAL_DELAY);
        for (uint256 i; i < count; ++i) {
            _packsOf[buyer].push(packs.length);
            packs.push(Pack(buyer, reveal, false));
        }
    }

    // ─── Open ───────────────────────────────────────────────────
    /// @notice Open a pack once its reveal block is mined. If the blockhash aged out (>256 blocks),
    ///         the pack is re-committed to a new future block instead of opening.
    function open(uint256 packId) external nonReentrant returns (uint256[5] memory ids) {
        Pack storage p = packs[packId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.opened) revert AlreadyOpened();
        if (block.number <= p.revealBlock) revert TooEarly(p.revealBlock);
        bytes32 bh = blockhash(p.revealBlock);
        if (bh == bytes32(0)) {
            p.revealBlock = uint64(block.number + REVEAL_DELAY);
            emit PackRecommitted(packId, p.revealBlock);
            return ids;
        }
        p.opened = true;
        ids = roll(keccak256(abi.encode(bh, packId, p.owner, address(this))));
        uint256[] memory mintIds = new uint256[](CARDS_PER_PACK);
        uint256[] memory amounts = new uint256[](CARDS_PER_PACK);
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            mintIds[i] = ids[i];
            amounts[i] = 1;
        }
        cards.mintBatch(msg.sender, mintIds, amounts);
        emit PackOpened(packId, msg.sender, ids);
    }

    /// @notice Deterministic pack contents for a given random word.
    function roll(bytes32 rand) public view returns (uint256[5] memory ids) {
        uint256[] memory commons = cards.cardsOfRarity(0);
        uint256[] memory uncommons = cards.cardsOfRarity(1);
        uint256[] memory rares = cards.cardsOfRarity(2);
        uint256[] memory legendaries = cards.cardsOfRarity(3);
        for (uint256 i; i < 3; ++i) {
            ids[i] = commons[uint256(keccak256(abi.encode(rand, i))) % commons.length];
        }
        ids[3] = uncommons[uint256(keccak256(abi.encode(rand, 3))) % uncommons.length];
        bool upgrade = uint256(keccak256(abi.encode(rand, "legendary"))) % 10_000 < LEGENDARY_UPGRADE_BPS;
        uint256[] memory top = upgrade && legendaries.length > 0 ? legendaries : rares;
        ids[4] = top[uint256(keccak256(abi.encode(rand, 4))) % top.length];
    }

    /// @notice Every pack id ever bought by `owner` (opened or not), oldest first.
    function packIdsOf(address owner) external view returns (uint256[] memory) {
        return _packsOf[owner];
    }

    function packCount() external view returns (uint256) {
        return packs.length;
    }
}
