// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
import {PackSale} from "../src/PackSale.sol";
import {SeasonPass} from "../src/SeasonPass.sol";

/// @notice Adds the SeasonPass to a live deployment that predates it, at about four packs' price (ETH and test
///         USDC, as PackSale charges), paid to PackSale's treasury, and records it in the address book.
///   forge script script/AddSeasonPass.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract AddSeasonPass is ForkfallScript {
    /// @notice Must match PASS_EPOCH_DAY in packages/engine/src/pass.ts (Monday 5 Oct 2026, 00:00 UTC).
    uint256 internal constant EPOCH = 1791158400;

    function run() external {
        requireTestnet();
        string memory book = vm.readFile(bookPath());
        if (vm.keyExistsJson(book, ".SeasonPass")) {
            console2.log("SeasonPass already deployed at", vm.parseJsonAddress(book, ".SeasonPass"));
            return;
        }
        PackSale packs = PackSale(addr("PackSale"));
        address usdc = addr("TestUSDC");
        vm.startBroadcast();
        SeasonPass pass = new SeasonPass(msg.sender, packs.treasury(), EPOCH, packs.ethPrice() * 4);
        pass.setTokenPrice(usdc, packs.tokenPrice(usdc) * 4);
        vm.stopBroadcast();
        vm.serializeJson("book", book);
        vm.writeJson(vm.serializeAddress("book", "SeasonPass", address(pass)), bookPath());
        console2.log("SeasonPass deployed at", address(pass));
    }
}
