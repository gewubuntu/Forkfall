// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @notice Faucet ERC-20 for testnets. Anyone may drip once per cooldown; the owner can mint freely.
contract FaucetToken is ERC20, Ownable, TestnetOnly {
    uint8 private immutable _dec;
    uint256 public immutable dripAmount;
    uint256 public constant COOLDOWN = 1 days;
    mapping(address => uint256) public lastDrip;

    error Cooldown(uint256 readyAt);

    constructor(string memory n, string memory s, uint8 dec_, uint256 drip_, address owner_)
        ERC20(n, s)
        Ownable(owner_)
    {
        _dec = dec_;
        dripAmount = drip_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function drip() external {
        uint256 ready = lastDrip[msg.sender] + COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < ready) revert Cooldown(ready);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, dripAmount);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
