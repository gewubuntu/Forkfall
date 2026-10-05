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
///        per pack; the callback only stores it (fixed gas, nothing a player can make fail). A wallet's VRF packs
///        then open strictly oldest first, rolling from the word with duplicate protection counting the copies
///        pulled from packs (not current holdings). Every input is fixed once the word exists, so opening is fully
///        determined: no one can bias the word or steer a pack (by opening order, timing, or moving cards around).
///        Required for mainnet.
///      - Otherwise a two-step commit/blockhash: buying commits to a future block, opening reads that block's
///        hash. Fine for testnets: a block producer could in principle withhold a block to re-roll, and contents
///        depend on the opener's holdings when opening.
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
    /// @notice VRF callback gas: this base plus `callbackGasPerPack` per pack. The callback only stores one word per
    ///         pack (no rolling, no external calls), so its cost is fixed and independent of the owner's cards.
    uint256 public constant CALLBACK_GAS_BASE = 60_000;

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
    /// @notice Per pack: its latest VRF request (0 = a commit/blockhash pack) and its random word (0 = waiting).
    mapping(uint256 => uint256) public vrfRequestOf;
    mapping(uint256 => uint256) public vrfWordOf;
    /// @notice Each wallet's VRF packs open oldest first: the queue of its VRF pack ids and how many are done.
    ///         With the order fixed, a word known in advance can't be steered by choosing which pack to open when.
    mapping(address => uint256[]) private _vrfQueue;
    mapping(address => uint256) public vrfQueueHead;
    /// @notice Copies of each card (base id) a wallet has pulled from packs. Duplicate protection for VRF packs
    ///         counts these instead of current holdings, which a player could change by moving cards around.
    mapping(address => mapping(uint256 => uint256)) public pulled;

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
    /// @notice The pity counter for VRF packs, kept apart from blockhash packs: those can be opened at any time, so
    ///         sharing a counter (or `pulled`) would let a wallet steer a VRF pack whose word is already public.
    mapping(address => uint256) public vrfPacksSinceLegendary;

    error BadCount();
    error WrongPayment();
    error TokenNotAccepted(address token);
    error NotOwner();
    error AlreadyOpened();
    error TooEarly(uint256 revealBlock);
    error UnknownKind(uint8 kind);
    error RandomnessPending(uint256 packId);
    error NotRetryable(uint256 packId);
    error OpenInOrder(uint256 nextPackId);

    event PacksBought(address indexed buyer, uint256 firstPackId, uint256 count, address payToken, uint256 paid);
    event PacksBoughtOfKind(address indexed buyer, uint256 firstPackId, uint256 count, uint8 kind);
    event KindSet(uint8 indexed kind, string name, uint256 cards);
    event PackOpened(uint256 indexed packId, address indexed owner, uint256[5] cardIds);
    event PackRecommitted(uint256 indexed packId, uint64 revealBlock);
    event PacksGranted(address indexed to, uint256 firstPackId, uint256 count, uint8 kind);
    event VrfSet(address coordinator, bytes32 keyHash, uint256 subId);
    event RandomnessRequested(uint256 indexed requestId, uint256 firstPackId, uint256 count);
    event PacksSeeded(uint256 indexed requestId, uint256 firstPackId, uint256 count);
    event PackSeeded(uint256 indexed packId, uint256 word);

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
        if (vrf.coordinator != address(0)) {
            for (uint256 i; i < count; ++i) {
                _vrfQueue[buyer].push(firstId + i);
            }
            _requestRandomness(firstId, count);
        }
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
        // Keyed by coordinator and id: two coordinators may hand out the same ids.
        uint256 key = _requestKey(c.coordinator, requestId);
        vrfRequests[key] = VrfRequest(firstId, uint64(count), uint64(block.number), c.coordinator);
        for (uint256 i; i < count; ++i) {
            vrfRequestOf[firstId + i] = key;
        }
        emit RandomnessRequested(requestId, firstId, count);
    }

    /// @notice Chainlink VRF callback: stores one word per pack, nothing else, so its gas is fixed and no player
    ///         action can make it fail. The first answer to any request covering a pack wins, so a retry can never
    ///         swap a known word. Unknown or already-answered requests are ignored; never reverts for a known
    ///         request from its coordinator.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        // Only the coordinator a request went to can answer it: the key includes the caller, so anyone else's
        // call finds nothing and does nothing.
        uint256 key = _requestKey(msg.sender, requestId);
        VrfRequest memory r = vrfRequests[key];
        if (r.coordinator == address(0) || words.length < r.count) return;
        delete vrfRequests[key];
        for (uint256 i; i < r.count; ++i) {
            uint256 packId = r.firstPackId + i;
            if (vrfRequestOf[packId] == 0 || vrfWordOf[packId] != 0) continue;
            uint256 w = words[i] == 0 ? 1 : words[i];
            vrfWordOf[packId] = w;
            emit PackSeeded(packId, w);
        }
        emit PacksSeeded(requestId, r.firstPackId, r.count);
    }

    function _requestKey(address coordinator, uint256 requestId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(coordinator, requestId)));
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
        if (req == 0 || vrfWordOf[packId] != 0 || packs[packId].opened) return 0;
        return uint256(vrfRequests[req].requestedAt) + VRF_RETRY_BLOCKS;
    }

    /// @notice The VRF pack `owner` must open next (type(uint256).max if none).
    function nextVrfPack(address owner) public view returns (uint256) {
        uint256 h = vrfQueueHead[owner];
        return h < _vrfQueue[owner].length ? _vrfQueue[owner][h] : type(uint256).max;
    }

    /// @notice Whether `open` makes progress now. VRF packs: its word is in and it's the owner's oldest unopened VRF
    ///         pack (or VRF was switched off and its request is old enough to re-seal). Blockhash packs: the reveal
    ///         block has passed.
    function packReady(uint256 packId) public view returns (bool) {
        Pack storage p = packs[packId];
        if (p.opened) return false;
        uint256 req = vrfRequestOf[packId];
        if (req == 0) return block.number > p.revealBlock;
        if (nextVrfPack(p.owner) != packId) return false;
        if (vrfWordOf[packId] != 0) return true;
        return vrf.coordinator == address(0) && block.number >= retryableAt(packId);
    }

    // ─── Open ───────────────────────────────────────────────────
    /// @notice Open a pack. VRF packs open oldest first and roll from their word; duplicate protection counts the
    ///         copies pulled from packs. Blockhash packs roll from their reveal block's hash and the opener's holdings;
    ///         if the hash aged out (>256 blocks) the pack is re-sealed to a new future block instead. A VRF pack whose
    ///         word never came after VRF was switched off is re-sealed the same way (once its request is
    ///         `VRF_RETRY_BLOCKS` old, so an answer already on its way can't be dodged).
    function open(uint256 packId) external nonReentrant returns (uint256[5] memory ids) {
        Pack storage p = packs[packId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.opened) revert AlreadyOpened();
        bytes32 rand;
        bool fromPulls;
        if (vrfRequestOf[packId] != 0) {
            uint256 expected = nextVrfPack(msg.sender);
            if (expected != packId) revert OpenInOrder(expected);
            uint256 w = vrfWordOf[packId];
            if (w == 0) {
                if (vrf.coordinator != address(0) || block.number < retryableAt(packId)) {
                    revert RandomnessPending(packId);
                }
                vrfRequestOf[packId] = 0;
                vrfQueueHead[msg.sender]++;
                p.revealBlock = uint64(block.number + REVEAL_DELAY);
                emit PackRecommitted(packId, p.revealBlock);
                return ids;
            }
            vrfQueueHead[msg.sender]++;
            rand = keccak256(abi.encode(w, packId, p.owner, address(this)));
            fromPulls = true;
        } else {
            if (block.number <= p.revealBlock) revert TooEarly(p.revealBlock);
            bytes32 bh = blockhash(p.revealBlock);
            if (bh == bytes32(0)) {
                p.revealBlock = uint64(block.number + REVEAL_DELAY);
                emit PackRecommitted(packId, p.revealBlock);
                return ids;
            }
            rand = keccak256(abi.encode(bh, packId, p.owner, address(this)));
        }
        p.opened = true;
        // VRF and blockhash packs keep separate pity counters, and only VRF opens feed `pulled`.
        mapping(address => uint256) storage counter = fromPulls ? vrfPacksSinceLegendary : packsSinceLegendary;
        bool pity = counter[msg.sender] + 1 >= PITY_PACKS;
        ids = _roll(rand, msg.sender, pity, p.kind, fromPulls);
        bool gotLegendary;
        uint256 foil = cards.FOIL_OFFSET();
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            uint256 base = ids[i] >= foil ? ids[i] - foil : ids[i];
            if (fromPulls) pulled[msg.sender][base]++;
            if (cards.cardInfo(base).rarity == 3) gotLegendary = true;
        }
        counter[msg.sender] = gotLegendary ? 0 : counter[msg.sender] + 1;
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

    /// @notice Packs left until the pity timer guarantees a Legendary for `who` (1 = the next pack), for the
    ///         randomness source packs are sold with now (VRF and blockhash packs count separately).
    function packsUntilPity(address who) external view returns (uint256) {
        return PITY_PACKS - (vrf.coordinator != address(0) ? vrfPacksSinceLegendary[who] : packsSinceLegendary[who]);
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
        return _roll(rand, opener, forceLegendary, kind, false);
    }

    /// @notice What `owner`'s next VRF pack will hold once its word is in (all zero if it isn't): anyone can check
    ///         that opening is deterministic.
    function previewVrfOpen(address owner) external view returns (uint256 packId, uint256[5] memory ids) {
        packId = nextVrfPack(owner);
        if (packId == type(uint256).max || vrfWordOf[packId] == 0) return (packId, ids);
        bool pity = vrfPacksSinceLegendary[owner] + 1 >= PITY_PACKS;
        ids = _roll(
            keccak256(abi.encode(vrfWordOf[packId], packId, owner, address(this))),
            owner,
            pity,
            packs[packId].kind,
            true
        );
    }

    /// @dev `fromPulls`: duplicate protection counts copies pulled from packs (VRF) instead of current holdings.
    function _roll(bytes32 rand, address opener, bool forceLegendary, uint8 kind, bool fromPulls)
        internal
        view
        returns (uint256[5] memory ids)
    {
        uint256[] memory legendaries = kindCards(kind, 3);
        uint256[] memory commons = kindCards(kind, 0);
        uint256[5] memory got; // base ids already in this pack, for duplicate protection within the pack
        for (uint256 i; i < 3; ++i) {
            got[i] = _pick(commons, uint256(keccak256(abi.encode(rand, i))), opener, got, 2, fromPulls);
        }
        got[3] = _pick(kindCards(kind, 1), uint256(keccak256(abi.encode(rand, 3))), opener, got, 2, fromPulls);
        bool upgrade =
            forceLegendary || uint256(keccak256(abi.encode(rand, "legendary"))) % 10_000 < LEGENDARY_UPGRADE_BPS;
        bool legendary = upgrade && legendaries.length > 0;
        got[4] = _pick(
            legendary ? legendaries : kindCards(kind, 2),
            uint256(keccak256(abi.encode(rand, 4))),
            opener,
            got,
            legendary ? 1 : 2,
            fromPulls
        );
        for (uint256 i; i < CARDS_PER_PACK; ++i) {
            bool foil = uint256(keccak256(abi.encode(rand, "foil", i))) % 10_000 < FOIL_BPS;
            ids[i] = foil ? got[i] + cards.FOIL_OFFSET() : got[i];
        }
    }

    /// @dev Start at a random card of `pool`; walk forward to the first one the opener holds fewer than `limit`
    ///      of (counting this pack). If every card is at the limit, keep the random pick (extras can be scrapped).
    function _pick(
        uint256[] memory pool,
        uint256 r,
        address opener,
        uint256[5] memory got,
        uint256 limit,
        bool fromPulls
    ) internal view returns (uint256) {
        uint256 start = r % pool.length;
        for (uint256 k; k < pool.length; ++k) {
            uint256 id = pool[(start + k) % pool.length];
            uint256 have = fromPulls ? pulled[opener][id] : cards.playableBalance(opener, id);
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
