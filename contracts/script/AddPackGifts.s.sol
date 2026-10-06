// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
import {PackSale} from "../src/PackSale.sol";
import {PackGifts} from "../src/PackGifts.sol";

/// @notice Adds PackGifts to a live deployment that predates it: deploys it with the book's referee as the deliverer,
///         lets it grant packs on PackSale (the broadcaster must be PackSale's admin), and records it in the book.
///   forge script script/AddPackGifts.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract AddPackGifts is ForkfallScript {
    function run() external {
        requireTestnet();
        string memory book = vm.readFile(bookPath());
        if (vm.keyExistsJson(book, ".PackGifts")) {
            console2.log("PackGifts already deployed at", vm.parseJsonAddress(book, ".PackGifts"));
            return;
        }
        PackSale packs = PackSale(addr("PackSale"));
        address referee = vm.parseJsonAddress(book, ".referee");
        vm.startBroadcast();
        PackGifts gifts = new PackGifts(packs, msg.sender, referee);
        packs.grantRole(packs.PACK_GRANTER_ROLE(), address(gifts));
        vm.stopBroadcast();
        vm.serializeJson("book", book);
        vm.writeJson(vm.serializeAddress("book", "PackGifts", address(gifts)), bookPath());
        console2.log("PackGifts deployed at", address(gifts));
    }
}
