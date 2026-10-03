// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CardRegistry} from "./CardRegistry.sol";
import {IVRFConsumer, IVRFCoordinatorV2Plus, VRFV2PlusClient} from "./vrf/VRFV2Plus.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title PackSale
/// @notice Sells 5-card Set 1 packs for ETH or an allowlisted ERC-20 (test USDC, test game token).
///         Pack: 3 Common, 1 Uncommon, 1 Rare that upgrades to Legendary ~1 in 10.
///         Fairness: a pity timer guarantees a Legendary within `PITY_PACKS` packs per wallet, and duplicate
///         protection skips cards the opener already holds at the deck limit (2, or 1 for a Legendary) until
///         every card of that rarity is at the limit. Each card is a cosmetic foil ~1 in 15 (same card in play).
/// @dev Randomness, per pack, from one of two sources:
///      - Chainlink VRF v2.5 (once `setVrf` configures a coordinator): buying requests one verifiable random word
///        per pack, and the coordinator's callback rolls the pack's contents from it on the spot (pity counter and
///        duplicate protection read at that instant), before anyone can see the word. Opening only mints them, so
///        no one (players, the block producer, this contract's admin) can bias or pick between outcomes.
///        Required for mainnet.
///      - Otherwise a two-step commit/blockhash: buying commits to a future block, opening reads that block's
///        hash. Fine for testnets: a block producer could in principle withhold a block to re-roll, and contents
///        depend on the opener's state when opening (pity, duplicates), after the hash is known.
contract PackSale is AccessControl, ReentrancyGuard, TestnetOnly, IVRFConsumer {
    using SafeERC20 for IERC20;

    bytes32 public constant PRICE_ADMIN_ROLE = keccak256("PRICE_ADMIN_ROLE");
    /// @notice Configures the randomness source (Chainlink VRF coordinator, key hash, subscription).
    bytes32 public constant RANDOMNESS_ADMIN_ROLE = keccak256("RANDOMNESS_ADMIN_ROLE");
    /// @notice May hand out free packs (quest rewards): the QuestRewards contract.
    bytes32 public constant PACK_GRANTER_ROLE = keccak256("PACK_GRANTER_ROLE");

    uint256 public constant CARDS_PER_PACK = 5;
    uint256 public constant LEGENDARY_UPGRADE_BPS = 1_000; // 10%
    uint256 public constant MAX_PACKS_PER_TX = 10;
    uint256 public constant REVEAL_DELAY = 2;
    uint256 public constant PITY_PACKS = 20;
    uint256 public constant FOIL_BPS = 667; // ~1 in 15 cards
    /// @notice Bundle discounts: 5+ packs 10% off, 10 packs 15% off.
    uint256 public constant BUNDLE5_BPS = 9_000;
    uint256 public constant BUNDLE10_BPS = 8_500;
    /// @notice Pack kinds: 0 = Set 1 booster (every card); others are themed boosters with their own pool.
    uint8 public constant KIND_SET1 = 0;
    /// @notice A VRF request unanswered for this many blocks may be re-requested by the pack's owner.
    uint256 public constant VRF_RETRY_BLOCKS = 500;
    /// @notice VRF callback gas: this base plus `callbackGasPerPack` per pack. Rolling contents in the callback costs
    ///         ~250k for a first (cold) pack and ~150k for each further one, so 300k + 150k/pack covers 1–10 packs
    ///         (≤ 1.8M, under Chainlink's 2.5M callback maximum).
    uint256 public constant CALLBACK_GAS_BASE = 300_000;

    /// @notice Chainlink VRF v2.5 settings; `vrfCoordinator == 0` means the commit/blockhash source.
    struct VrfConfig {
        address coordinator;
        bytes32 keyHash;
        uint256 subId;
        uint16 confirmations;
        uint32 callbackGasPerPack;
        bool nativePayment;
    }

    VrfConfig public vrf;

    /// @notice VRF request → the packs it seeds (`count` packs from `firstPackId`), when it was made, and the
    ///         coordinator it went to (its answer is accepted even if `setVrf` has since changed the coordinator).
    struct VrfRequest {
        uint256 firstPackId;
        uint64 count;
        uint64 requestedAt;
        address coordinator;
    }

    mapping(uint256 => VrfRequest) public vrfRequests;
    /// @notice Per pack: its latest VRF request (0 = a commit/blockhash pack).
    mapping(uint256 => uint256) public vrfRequestOf;
    /// @notice Per VRF pack: its contents, fixed the moment its random word arrives (5 card ids, 32 bits each, plus
    ///         the top bit set); 0 while waiting. Opening only mints them.
    mapping(uint256 => uint256) public rolledOf;

    CardRegistry public immutable cards;
    address payable public treasury;
    uint256 public ethPrice;
    mapping(address => uint256) public tokenPrice; // 0 = not accepted

    struct Pack {
        address owner;
        uint64 revealBlock;
        bool opened;
        uint8 kind;
    }

    /// @notice Themed booster pools (kind => rarity => card ids) and names; kind 0 uses every card.
    mapping(uint8 => mapping(uint8 => uint256[])) private _pool;
    mapping(uint8 => string) public kindName;

    Pack[] public packs;
    mapping(address => uint256[]) private _packsOf;
    /// @notice Packs opened since this wallet's last Legendary (the pity counter).
    mapping(address => uint256) public packsSinceLegendary;

    error BadCount();
    error WrongPayment();
    error TokenNotAccepted(address token);
    error NotOwner();
    error AlreadyOpened();
    error TooEarly(uint256 revealBlock);
    error UnknownKind(uint8 kind);
    error RandomnessPending(uint256 packId);
    error OnlyCoordinator(address have, address want);
    error NotRetryable(uint256 packId);

    event PacksBought(address indexed buyer, uint256 firstPackId, uint256 count, address payToken, uint256 paid);
    event PacksBoughtOfKind(address indexed buyer, uint256 firstPackId, uint256 count, uint8 kind);
    event KindSet(uint8 indexed kind, string name, uint256 cards);
    event PackOpened(uint256 indexed packId, address indexed owner, uint256[5] cardIds);
    event PackRecommitted(uint256 indexed packId, uint64 revealBlock);
    event PacksGranted(address indexed to, uint256 firstPackId, uint256 count, uint8 kind);
    event VrfSet(address coordinator, bytes32 keyHash, uint256 subId);
    event RandomnessRequested(uint256 indexed requestId, uint256 firstPackId, uint256 count);
    event PacksSeeded(uint256 indexed requestId, uint256 firstPackId, uint256 count);
    event PackRolled(uint256 indexed packId, uint256 word, uint256[5] cardIds);

    constructor(CardRegistry cards_, address admin, address payable treasury_, uint256 ethPrice_) {
        cards = cards_;
        treasury = treasury_;
        ethPrice = ethPrice_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICE_ADMIN_ROLE, admin);
        _grantRole(RANDOMNESS_ADMIN_ROLE, admin);
    }

    /// @notice Switch packs bought from now on to Chainlink VRF (or back to blockhash with coordinator 0).
    ///         The subscription must list this contract as a consumer and hold LINK (or native, if chosen).
    function setVrf(VrfConfig calldata c) external onlyRole(RANDOMNESS_ADMIN_ROLE) {
        vrf = c;
        emit VrfSet(c.coordinator, c.keyHash, c.subId);
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

    // ─── Themed boosters ────────────────────────────────────────
    /// @notice Define a themed booster: its name and card pool (grouped by rarity on-chain). Needs Commons,
    ///         Uncommons and Rares; without Legendaries the Legendary upgrade falls back to a Rare.
    function setKind(uint8 kind, string calldata name, uint256[] calldata ids) external onlyRole(PRICE_ADMIN_ROLE) {
        require(kind != KIND_SET1, "PackSale: kind 0 is the full set");
        for (uint8 r; r < 4; ++r) {
            delete _pool[kind][r];
        }
        for (uint256 i; i < ids.length; ++i) {
            _pool[kind][cards.cardInfo(ids[i]).rarity].push(ids[i]);
        }
        require(
            _pool[kind][0].length > 0 && _pool[kind][1].length > 0 && _pool[kind][2].length > 0,
            "PackSale: pool needs C/U/R"
        );
        kindName[kind] = name;
        emit KindSet(kind, name, ids.length);
    }

    function kindCards(uint8 kind, uint8 rarity) public view returns (uint256[] memory) {
        return kind == KIND_SET1 ? cards.cardsOfRarity(rarity) : _pool[kind][rarity];
    }

    function kindExists(uint8 kind) public view returns (bool) {
        return kind == KIND_SET1 || _pool[kind][0].length > 0;
    }

    // ─── Buy ────────────────────────────────────────────────────
    /// @notice Price of `count` packs at `unit` each, after the bundle discount.
    function bundlePrice(uint256 unit, uint256 count) public pure returns (uint256) {
        uint256 bps = count >= 10 ? BUNDLE10_BPS : count >= 5 ? BUNDLE5_BPS : 10_000;
        return (unit * count * bps) / 10_000;
    }

    function quoteEth(uint256 count) external view returns (uint256) {
        return bundlePrice(ethPrice, count);
    }

    function quoteToken(address token, uint256 count) external view returns (uint256) {
        return bundlePrice(tokenPrice[token], count);
    }

    function buyWithEth(uint256 count) external payable returns (uint256) {
        return buyWithEthOf(KIND_SET1, count);
    }

    function buyWithToken(address token, uint256 count) external returns (uint256) {
        return buyWithTokenOf(token, KIND_SET1, count);
    }

    function buyWithEthOf(uint8 kind, uint256 count) public payable nonReentrant returns (uint256 firstId) {
        if (count == 0 || count > MAX_PACKS_PER_TX) revert BadCount();
        if (!kindExists(kind)) revert UnknownKind(kind);
        if (ethPrice == 0 || msg.value != bundlePrice(ethPrice, count)) revert WrongPayment();
        firstId = _commit(msg.sender, count, kind);
        (bool ok,) = treasury.call{value: msg.value}("");
        require(ok, "PackSale: treasury transfer failed");
        emit PacksBought(msg.sender, firstId, count, address(0), msg.value);
        emit PacksBoughtOfKind(msg.sender, firstId, count, kind);
    }

    function buyWithTokenOf(address token, uint8 kind, uint256 count) public nonReentrant returns (uint256 firstId) {
        if (count == 0 || count > MAX_PACKS_PER_TX) revert BadCount();
        if (!kindExists(kind)) revert UnknownKind(kind);
        uint256 price = tokenPrice[token];
        if (price == 0) revert TokenNotAccepted(token);
        uint256 total = bundlePrice(price, count);
        IERC20(token).safeTransferFrom(msg.sender, treasury, total);
        firstId = _commit(msg.sender, count, kind);
        emit PacksBought(msg.sender, firstId, count, token, total);
        emit PacksBoughtOfKind(msg.sender, firstId, count, kind);
    }

    /// @notice Free packs (quest rewards). Same odds, pity timer, duplicate protection and foils as bought packs.
    function grantPacks(address to, uint8 kind, uint256 count)
        external
        onlyRole(PACK_GRANTER_ROLE)
        nonReentrant
        returns (uint256 firstId)
    {
        if (count == 0 || count > MAX_PACKS_PER_TX) revert BadCount();
        if (!kindExists(kind)) revert UnknownKind(kind);
        firstId = _commit(to, count, kind);
        emit PacksGranted(to, firstId, count, kind);
    }

    function _commit(address buyer, uint256 count, uint8 kind) internal returns (uint256 firstId) {
        firstId = packs.length;
        uint64 reveal = uint64(block.number + REVEAL_DELAY);
        for (uint256 i; i < count; ++i) {
            _packsOf[buyer].push(packs.length);
            packs.push(Pack(buyer, reveal, false, kind));
        }
        if (vrf.coordinator != address(0)) _requestRandomness(firstId, count);
    }

    function _requestRandomness(uint256 firstId, uint256 count) internal {
        VrfConfig memory c = vrf;
        uint256 requestId = IVRFCoordinatorV2Plus(c.coordinator)
            .requestRandomWords(
                VRFV2PlusClient.RandomWordsRequest({
                    keyHash: c.keyHash,
                    subId: c.subId,
                    requestConfirmations: c.confirmations,
                    callbackGasLimit: uint32(CALLBACK_GAS_BASE + uint256(c.callbackGasPerPack) * count),
                    numWords: uint32(count),
                    extraArgs: VRFV2PlusClient._argsToBytes(
                        VRFV2PlusClient.ExtraArgsV1({nativePayment: c.nativePayment})
                    )
                })
            );
        vrfRequests[requestId] = VrfRequest(firstId, uint64(count), uint64(block.number), c.coordinator);
        for (uint256 i; i < count; ++i) {
            vrfRequestOf[firstId + i] = requestId;
        }
        emit RandomnessRequested(requestId, firstId, count);
    }

    /// @notice Chainlink VRF callback. Rolls each pack's contents right here, from its word and the owner's state at
    ///         this instant (pity counter, duplicate protection), before anyone can see the word: nothing a player
    ///         does afterwards (opening order, moving cards away) can change what a pack holds. The first answer to
    ///         any request covering a pack wins, so a retry can never re-roll a pack. Never reverts for a known
    ///         request from its coordinator; unknown or already-answered requests are ignored.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        VrfRequest memory r = vrfRequests[requestId];
        if (r.coordinator == address(0)) return;
        if (msg.sender != r.coordinator) revert OnlyCoordinator(msg.sender, r.coordinator);
        if (words.length < r.count) return;
        delete vrfRequests[requestId];
        for (uint256 i; i < r.count; ++i) {
            uint256 packId = r.firstPackId + i;
            if (vrfRequestOf[packId] == 0 || rolledOf[packId] != 0 || packs[packId].opened) continue;
            _rollVrfPack(packId, words[i]);
        }
        emit PacksSeeded(requestId, r.firstPackId, r.count);
    }

    function _rollVrfPack(uint256 packId, uint256 word) internal {
        Pack storage p = packs[packId];
        address owner = p.owner;
        bool pity = packsSinceLegendary[owner] + 1 >= PITY_PACKS;
        uint256[5] memory ids = roll(keccak256(abi.encode(word, packId, owner, address(this))), owner, pity, p.kind);
        bool gotLegendary;
        uint256 packed = uint256(1) << 255;
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            packed |= ids[i] << (32 * i);
            if (cards.cardInfo(ids[i]).rarity == 3) gotLegendary = true;
        }
        packsSinceLegendary[owner] = gotLegendary ? 0 : packsSinceLegendary[owner] + 1;
        rolledOf[packId] = packed;
        emit PackRolled(packId, word, ids);
    }

    /// @notice If a pack's VRF request went unanswered for `VRF_RETRY_BLOCKS`, its owner can request again. The old
    ///         request stays valid: whichever answer arrives first decides the pack.
    function retryRandomness(uint256 packId) external nonReentrant {
        if (packs[packId].owner != msg.sender) revert NotOwner();
        uint256 at = retryableAt(packId);
        if (at == 0 || block.number < at || vrf.coordinator == address(0)) revert NotRetryable(packId);
        _requestRandomness(packId, 1);
    }

    /// @notice Block from which `retryRandomness` is allowed for a pack still waiting on VRF (0 = not waiting).
    function retryableAt(uint256 packId) public view returns (uint256) {
        uint256 req = vrfRequestOf[packId];
        if (req == 0 || rolledOf[packId] != 0 || packs[packId].opened) return 0;
        return uint256(vrfRequests[req].requestedAt) + VRF_RETRY_BLOCKS;
    }

    /// @notice Whether `open` makes progress now: VRF contents rolled, a reveal block passed, or a VRF pack whose
    ///         randomness was switched off (opening then re-seals it to a blockhash).
    function packReady(uint256 packId) public view returns (bool) {
        Pack storage p = packs[packId];
        if (p.opened) return false;
        if (vrfRequestOf[packId] != 0) return rolledOf[packId] != 0 || vrf.coordinator == address(0);
        return block.number > p.revealBlock;
    }

    // ─── Open ───────────────────────────────────────────────────
    /// @notice Open a pack. A VRF pack mints the contents fixed when its word arrived. A commit/blockhash pack
    ///         rolls now from its reveal block's hash; if that hash aged out (>256 blocks) it is re-sealed to a new
    ///         future block instead. A VRF pack still waiting after VRF was switched off is re-sealed the same way.
    function open(uint256 packId) external nonReentrant returns (uint256[5] memory ids) {
        Pack storage p = packs[packId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.opened) revert AlreadyOpened();
        if (vrfRequestOf[packId] != 0) {
            uint256 rolled = rolledOf[packId];
            if (rolled == 0) {
                if (vrf.coordinator != address(0)) revert RandomnessPending(packId);
                vrfRequestOf[packId] = 0;
                p.revealBlock = uint64(block.number + REVEAL_DELAY);
                emit PackRecommitted(packId, p.revealBlock);
                return ids;
            }
            p.opened = true;
            for (uint256 i; i < CARDS_PER_PACK; ++i) {
                ids[i] = (rolled >> (32 * i)) & type(uint32).max;
            }
            _mint(ids);
            emit PackOpened(packId, msg.sender, ids);
            return ids;
        }
        if (block.number <= p.revealBlock) revert TooEarly(p.revealBlock);
        bytes32 bh = blockhash(p.revealBlock);
        if (bh == bytes32(0)) {
            p.revealBlock = uint64(block.number + REVEAL_DELAY);
            emit PackRecommitted(packId, p.revealBlock);
            return ids;
        }
        p.opened = true;
        bool pity = packsSinceLegendary[msg.sender] + 1 >= PITY_PACKS;
        ids = roll(keccak256(abi.encode(bh, packId, p.owner, address(this))), msg.sender, pity, p.kind);
        bool gotLegendary;
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            if (cards.cardInfo(ids[i]).rarity == 3) gotLegendary = true;
        }
        packsSinceLegendary[msg.sender] = gotLegendary ? 0 : packsSinceLegendary[msg.sender] + 1;
        _mint(ids);
        emit PackOpened(packId, msg.sender, ids);
    }

    function _mint(uint256[5] memory ids) internal {
        uint256[] memory mintIds = new uint256[](CARDS_PER_PACK);
        uint256[] memory amounts = new uint256[](CARDS_PER_PACK);
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            mintIds[i] = ids[i];
            amounts[i] = 1;
        }
        cards.mintBatch(msg.sender, mintIds, amounts);
    }

    /// @notice Packs left until the pity timer guarantees a Legendary for `who` (1 = the next pack).
    function packsUntilPity(address who) external view returns (uint256) {
        return PITY_PACKS - packsSinceLegendary[who];
    }

    /// @notice Deterministic pack contents for a random word, opener and pity flag. Foils come back as
    ///         `FOIL_OFFSET + id`.
    function roll(bytes32 rand, address opener, bool forceLegendary) external view returns (uint256[5] memory) {
        return roll(rand, opener, forceLegendary, KIND_SET1);
    }

    /// @notice As above, from the pool of pack kind `kind`.
    function roll(bytes32 rand, address opener, bool forceLegendary, uint8 kind)
        public
        view
        returns (uint256[5] memory ids)
    {
        uint256[] memory legendaries = kindCards(kind, 3);
        uint256[5] memory got; // base ids already in this pack, for duplicate protection within the pack
        for (uint256 i; i < 3; ++i) {
            got[i] = _pick(kindCards(kind, 0), uint256(keccak256(abi.encode(rand, i))), opener, got, 2);
        }
        got[3] = _pick(kindCards(kind, 1), uint256(keccak256(abi.encode(rand, 3))), opener, got, 2);
        bool upgrade =
            forceLegendary || uint256(keccak256(abi.encode(rand, "legendary"))) % 10_000 < LEGENDARY_UPGRADE_BPS;
        bool legendary = upgrade && legendaries.length > 0;
        got[4] = _pick(
            legendary ? legendaries : kindCards(kind, 2),
            uint256(keccak256(abi.encode(rand, 4))),
            opener,
            got,
            legendary ? 1 : 2
        );
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            bool foil = uint256(keccak256(abi.encode(rand, "foil", i))) % 10_000 < FOIL_BPS;
            ids[i] = foil ? got[i] + cards.FOIL_OFFSET() : got[i];
        }
    }

    /// @dev Start at a random card of `pool`; walk forward to the first one the opener holds fewer than `limit`
    ///      of (counting this pack). If every card is at the limit, keep the random pick (extras can be scrapped).
    function _pick(uint256[] memory pool, uint256 r, address opener, uint256[5] memory got, uint256 limit)
        internal
        view
        returns (uint256)
    {
        uint256 start = r % pool.length;
        for (uint256 k; k < pool.length; ++k) {
            uint256 id = pool[(start + k) % pool.length];
            uint256 have = cards.playableBalance(opener, id);
            for (uint256 j; j < 5; ++j) {
                if (got[j] == id) have++;
            }
            if (have < limit) return id;
        }
        return pool[start];
    }

    /// @notice Every pack id ever bought by `owner` (opened or not), oldest first.
    function packIdsOf(address owner) external view returns (uint256[] memory) {
        return _packsOf[owner];
    }

    function packCount() external view returns (uint256) {
        return packs.length;
    }
}
