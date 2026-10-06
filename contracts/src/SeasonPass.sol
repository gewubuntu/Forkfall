// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title SeasonPass
/// @notice The premium track of the season pass: a fixed price for known rewards (no randomness in the purchase).
///         Seasons are four weeks from `epoch` (a Monday, 00:00 UTC), the same calendar the referee uses for XP.
///         Only the season that is running can be bought, for yourself or as a gift. The referee reads `hasPass`
///         and pays the premium tier rewards through QuestRewards; this contract only records who holds a pass.
contract SeasonPass is AccessControl, ReentrancyGuard, TestnetOnly {
    using SafeERC20 for IERC20;

    bytes32 public constant PRICE_ADMIN_ROLE = keccak256("PRICE_ADMIN_ROLE");
    uint256 public constant SEASON_LENGTH = 28 days;

    /// @notice Start of season 1 (unix seconds).
    uint256 public immutable epoch;
    address payable public treasury;
    uint256 public ethPrice;
    mapping(address => uint256) public tokenPrice; // 0 = not accepted
    /// @notice season => player => holds that season's premium pass.
    mapping(uint32 => mapping(address => bool)) public hasPass;

    event PassBought(
        uint32 indexed season, address indexed player, address indexed payer, address token, uint256 amount
    );
    event PricesSet(uint256 ethPrice);
    event TokenPriceSet(address indexed token, uint256 price);
    event TreasurySet(address treasury);

    error AlreadyHasPass(uint32 season, address player);
    error WrongPayment();
    error TokenNotAccepted(address token);
    error ZeroAddress();

    constructor(address admin, address payable treasury_, uint256 epoch_, uint256 ethPrice_) {
        if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICE_ADMIN_ROLE, admin);
        treasury = treasury_;
        epoch = epoch_;
        ethPrice = ethPrice_;
    }

    /// @notice The season running now (season 1 before and during the first four weeks).
    function currentSeason() public view returns (uint32) {
        if (block.timestamp < epoch) return 1;
        return uint32((block.timestamp - epoch) / SEASON_LENGTH + 1);
    }

    function buyWithEth(address player) external payable nonReentrant {
        if (ethPrice == 0 || msg.value != ethPrice) revert WrongPayment();
        uint32 season = _grant(player);
        (bool ok,) = treasury.call{value: msg.value}("");
        require(ok, "SeasonPass: treasury transfer failed");
        emit PassBought(season, player, msg.sender, address(0), msg.value);
    }

    function buyWithToken(address token, address player) external nonReentrant {
        uint256 price = tokenPrice[token];
        if (price == 0) revert TokenNotAccepted(token);
        uint32 season = _grant(player);
        IERC20(token).safeTransferFrom(msg.sender, treasury, price);
        emit PassBought(season, player, msg.sender, token, price);
    }

    function setEthPrice(uint256 p) external onlyRole(PRICE_ADMIN_ROLE) {
        ethPrice = p;
        emit PricesSet(p);
    }

    function setTokenPrice(address token, uint256 p) external onlyRole(PRICE_ADMIN_ROLE) {
        tokenPrice[token] = p;
        emit TokenPriceSet(token, p);
    }

    function setTreasury(address payable t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function _grant(address player) private returns (uint32 season) {
        if (player == address(0)) revert ZeroAddress();
        season = currentSeason();
        if (hasPass[season][player]) revert AlreadyHasPass(season, player);
        hasPass[season][player] = true;
    }
}
