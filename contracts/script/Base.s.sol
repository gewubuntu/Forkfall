// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Shared helpers: testnet guard and deployment address book (deployments/<chainId>.json).
abstract contract ForkfallScript is Script {
    error MainnetNotAllowed(uint256 chainId);

    function requireTestnet() internal view {
        uint256 id = block.chainid;
        bool ok = id == 31337 || id == 84532 || id == 46630 || id == 11155111;
        if (!ok) {
            console2.log("Refusing to run on chain", id, "- Forkfall MVP is testnet-only.");
            revert MainnetNotAllowed(id);
        }
    }

    function bookPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function addr(string memory key) internal view returns (address) {
        string memory json = vm.readFile(bookPath());
        return vm.parseJsonAddress(json, string.concat(".", key));
    }
}
