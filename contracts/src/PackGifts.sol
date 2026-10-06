// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PackSale} from "./PackSale.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title PackGifts
/// @notice Buy packs for someone else, at PackSale's own prices and bundle discounts. It holds PackSale's
///         PACK_GRANTER_ROLE and grants the packs to the friend: same odds, pity timer, duplicate protection and
///         foils as packs bought for yourself, and the payment goes to PackSale's treasury.
///
///         A gift can go straight to an address, or wait for a friend challenge: the buyer pays now, the packs are
///         held under a gift id the referee issued for the challenge, and the referee delivers them to whoever plays
///         the challenge once the match ends. A gift never delivered can be refunded to the buyer after `HOLD_TIME`.
contract PackGifts is AccessControl, ReentrancyGuard, TestnetOnly {
    using SafeERC20 for IERC20;

    /// @notice Delivers held gifts after the challenge match: the referee.
    bytes32 public constant DELIVERER_ROLE = keccak256("DELIVERER_ROLE");
    /// @notice A held gift can be refunded this long after it was bought (challenge links last a day).
    uint256 public constant HOLD_TIME = 3 days;

    enum State {
        None,
        Held,
        Delivered,
        Refunded
    }

    struct Gift {
        address from;
        uint8 kind;
        uint8 count;
        State state;
        uint40 refundableAt;
        address token; // address(0): paid in ETH
        uint256 paid;
    }

    PackSale public immutable packs;
    /// @notice Gifts held for a challenge, by the gift id the referee issued for it. Ids are never reused.
    mapping(bytes32 => Gift) public gifts;

    event PacksGifted(
        address indexed from,
        address indexed to,
        uint256 firstPackId,
        uint256 count,
        uint8 kind,
        address token,
        uint256 paid
    );
    event GiftHeld(
        bytes32 indexed giftId, address indexed from, uint256 count, uint8 kind, address token, uint256 paid
    );
    event GiftDelivered(bytes32 indexed giftId, address indexed to, uint256 firstPackId);
    event GiftRefunded(bytes32 indexed giftId, address indexed from);

    error WrongPayment();
    error TokenNotAccepted(address token);
    error ZeroAddress();
    error BadCount();
    error UnknownKind(uint8 kind);
    error GiftIdTaken(bytes32 giftId);
    error NotHeld(bytes32 giftId);
    error TooEarly(uint256 refundableAt);

    constructor(PackSale packs_, address admin, address deliverer) {
        if (address(packs_) == address(0) || admin == address(0) || deliverer == address(0)) revert ZeroAddress();
        packs = packs_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DELIVERER_ROLE, deliverer);
    }

    // ─── Straight to a friend ───────────────────────────────────
    function giftWithEth(address to, uint8 kind, uint256 count)
        external
        payable
        nonReentrant
        returns (uint256 firstId)
    {
        if (msg.value != _ethPrice(count)) revert WrongPayment();
        firstId = _grant(to, kind, count);
        _payTreasury(address(0), msg.value);
        emit PacksGifted(msg.sender, to, firstId, count, kind, address(0), msg.value);
    }

    function giftWithToken(address token, address to, uint8 kind, uint256 count)
        external
        nonReentrant
        returns (uint256 firstId)
    {
        uint256 total = _tokenPrice(token, count);
        IERC20(token).safeTransferFrom(msg.sender, packs.treasury(), total);
        firstId = _grant(to, kind, count);
        emit PacksGifted(msg.sender, to, firstId, count, kind, token, total);
    }

    // ─── Held for a challenge ───────────────────────────────────
    function holdWithEth(bytes32 giftId, uint8 kind, uint256 count) external payable nonReentrant {
        if (msg.value != _ethPrice(count)) revert WrongPayment();
        _hold(giftId, kind, count, address(0), msg.value);
    }

    function holdWithToken(address token, bytes32 giftId, uint8 kind, uint256 count) external nonReentrant {
        uint256 total = _tokenPrice(token, count);
        _hold(giftId, kind, count, token, total);
        IERC20(token).safeTransferFrom(msg.sender, address(this), total);
    }

    /// @notice The referee hands a held gift to the friend who played the challenge; the payment goes to the treasury.
    function deliver(bytes32 giftId, address to)
        external
        onlyRole(DELIVERER_ROLE)
        nonReentrant
        returns (uint256 firstId)
    {
        Gift storage g = gifts[giftId];
        if (g.state != State.Held) revert NotHeld(giftId);
        g.state = State.Delivered;
        firstId = _grant(to, g.kind, g.count);
        _payTreasury(g.token, g.paid);
        emit GiftDelivered(giftId, to, firstId);
        emit PacksGifted(g.from, to, firstId, g.count, g.kind, g.token, g.paid);
    }

    /// @notice A gift nobody played for goes back to its buyer (anyone may trigger it once it's refundable).
    function refund(bytes32 giftId) external nonReentrant {
        Gift storage g = gifts[giftId];
        if (g.state != State.Held) revert NotHeld(giftId);
        if (block.timestamp < g.refundableAt) revert TooEarly(g.refundableAt);
        g.state = State.Refunded;
        if (g.token == address(0)) {
            (bool ok,) = payable(g.from).call{value: g.paid}("");
            require(ok, "PackGifts: refund failed");
        } else {
            IERC20(g.token).safeTransfer(g.from, g.paid);
        }
        emit GiftRefunded(giftId, g.from);
    }

    // ─── Quotes (PackSale's prices and bundle discounts) ────────
    function quoteEth(uint256 count) external view returns (uint256) {
        return _ethPrice(count);
    }

    function quoteToken(address token, uint256 count) external view returns (uint256) {
        return _tokenPrice(token, count);
    }

    function _ethPrice(uint256 count) private view returns (uint256) {
        uint256 unit = packs.ethPrice();
        if (unit == 0) revert WrongPayment();
        return packs.bundlePrice(unit, count);
    }

    function _tokenPrice(address token, uint256 count) private view returns (uint256) {
        uint256 unit = packs.tokenPrice(token);
        if (unit == 0) revert TokenNotAccepted(token);
        return packs.bundlePrice(unit, count);
    }

    function _check(uint8 kind, uint256 count) private view {
        if (count == 0 || count > packs.MAX_PACKS_PER_TX()) revert BadCount();
        if (!packs.kindExists(kind)) revert UnknownKind(kind);
    }

    function _grant(address to, uint8 kind, uint256 count) private returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        _check(kind, count);
        return packs.grantPacks(to, kind, count);
    }

    function _hold(bytes32 giftId, uint8 kind, uint256 count, address token, uint256 paid) private {
        if (giftId == bytes32(0)) revert ZeroAddress();
        if (gifts[giftId].state != State.None) revert GiftIdTaken(giftId);
        _check(kind, count);
        uint40 refundableAt = uint40(block.timestamp + HOLD_TIME);
        gifts[giftId] = Gift(msg.sender, kind, uint8(count), State.Held, refundableAt, token, paid);
        emit GiftHeld(giftId, msg.sender, count, kind, token, paid);
    }

    function _payTreasury(address token, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = packs.treasury().call{value: amount}("");
            require(ok, "PackGifts: treasury transfer failed");
        } else {
            IERC20(token).safeTransfer(packs.treasury(), amount);
        }
    }
}
