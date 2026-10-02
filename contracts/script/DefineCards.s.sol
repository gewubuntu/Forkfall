// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {Set1Cards} from "../src/generated/Set1Cards.sol";

/// @notice Defines engine cards an existing CardRegistry does not know yet (e.g. the Poncho set, ids 41-48),
///         so a live deployment picks up new sets without a redeploy. Needs CARD_ADMIN_ROLE (the deployer).
///   forge script script/DefineCards.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract DefineCards is ForkfallScript {
    function run() external {
        requireTestnet();
        CardRegistry cards = CardRegistry(addr("CardRegistry"));
        (uint16[] memory ids, uint8[] memory races, uint8[] memory rarities, uint8[] memory chains) = Set1Cards.all();
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (!known(cards, ids[i])) n++;
        }
        if (n == 0) {
            console2.log("All", ids.length, "cards already defined.");
            return;
        }
        (uint16[] memory nIds, uint8[] memory nRaces, uint8[] memory nRarities, uint8[] memory nChains) =
            (new uint16[](n), new uint8[](n), new uint8[](n), new uint8[](n));
        uint256 j;
        for (uint256 i; i < ids.length; ++i) {
            if (known(cards, ids[i])) continue;
            (nIds[j], nRaces[j], nRarities[j], nChains[j]) = (ids[i], races[i], rarities[i], chains[i]);
            j++;
        }
        vm.startBroadcast();
        cards.defineCards(nIds, nRaces, nRarities, nChains);
        vm.stopBroadcast();
        console2.log("Defined new cards:", n);
    }

    function known(CardRegistry cards, uint256 id) internal view returns (bool) {
        try cards.cardInfo(id) returns (CardRegistry.CardInfo memory) {
            return true;
        } catch {
            return false;
        }
    }
}
