// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {PackSale} from "../src/PackSale.sol";
import {MatchSettlement} from "../src/MatchSettlement.sol";
import {AgentLeague} from "../src/AgentLeague.sol";
import {StarterDecks} from "../src/StarterDecks.sol";
import {Crafting} from "../src/Crafting.sol";
import {QuestRewards} from "../src/QuestRewards.sol";
import {Set1Cards} from "../src/generated/Set1Cards.sol";

/// @notice Read-only health check of a deployed hub, using deployments/<chainId>.json.
///   forge script script/CheckDeployment.s.sol --rpc-url base_sepolia
contract CheckDeployment is ForkfallScript {
    uint256 internal failures;

    function run() external {
        requireTestnet();
        console2.log("Checking Forkfall deployment on chain", block.chainid);

        string[13] memory names = [
            "CardRegistry",
            "StarterDecks",
            "PackSale",
            "Crafting",
            "QuestRewards",
            "AgentRegistry",
            "HumanRegistry",
            "DeckRegistry",
            "MatchSettlement",
            "SeasonRewards",
            "AgentLeague",
            "TestUSDC",
            "TestFALL"
        ];
        for (uint256 i; i < names.length; ++i) {
            check(addr(names[i]).code.length > 0, string.concat(names[i], " has code"));
        }

        CardRegistry cards = CardRegistry(addr("CardRegistry"));
        PackSale packs = PackSale(addr("PackSale"));
        MatchSettlement ms = MatchSettlement(addr("MatchSettlement"));
        address referee = addr("referee");
        AgentLeague league = AgentLeague(addr("AgentLeague"));
        check(address(ms.league()) == address(league), "MatchSettlement sends league results to AgentLeague");
        check(league.settlement() == address(ms), "AgentLeague accepts results from MatchSettlement");
        check(league.hasRole(league.REFEREE_ROLE(), referee), "referee can start league matches");

        check(cards.allCards().length == Set1Cards.COUNT, "all cards defined (core + Poncho, matches engine)");
        check(cards.hasRole(cards.MINTER_ROLE(), addr("StarterDecks")), "StarterDecks can mint");
        check(cards.hasRole(cards.MINTER_ROLE(), addr("PackSale")), "PackSale can mint");
        check(cards.hasRole(cards.MINTER_ROLE(), addr("Crafting")), "Crafting can mint");
        check(cards.hasRole(cards.BURNER_ROLE(), addr("Crafting")), "Crafting can burn");
        check(ms.hasRole(ms.REFEREE_ROLE(), referee), "referee holds REFEREE_ROLE");
        QuestRewards quests = QuestRewards(addr("QuestRewards"));
        Crafting crafting = Crafting(addr("Crafting"));
        check(quests.hasRole(quests.REWARDER_ROLE(), referee), "referee can pay quest rewards");
        check(crafting.hasRole(crafting.SCRAP_GRANTER_ROLE(), address(quests)), "QuestRewards can grant Scrap");
        check(packs.hasRole(packs.PACK_GRANTER_ROLE(), address(quests)), "QuestRewards can grant packs");
        check(packs.ethPrice() > 0, "pack ETH price set");
        check(packs.kindExists(1), "Poncho booster (pack kind 1) defined");
        check(packs.tokenPrice(addr("TestUSDC")) > 0, "pack tUSDC price set");
        check(StarterDecks(addr("StarterDecks")).starterList(1)[0] != 0, "starter lists readable");

        (address coordinator,, uint256 subId,,,) = packs.vrf();
        if (coordinator == address(0)) {
            console2.log("  [note] pack randomness: commit/blockhash (Chainlink VRF required before mainnet)");
        } else {
            console2.log("  [ok]   pack randomness: Chainlink VRF, coordinator", coordinator);
            if (block.chainid != 31337) check(subId != 0, "VRF subscription id set");
        }
        console2.log("season", ms.currentSeason());
        console2.log("pack price (wei)", packs.ethPrice());
        console2.log("referee", referee);
        console2.log("referee balance (wei)", referee.balance);
        if (failures == 0) console2.log("ALL CHECKS PASSED");
        else revert(string.concat(vm.toString(failures), " check(s) failed"));
    }

    function check(bool ok, string memory what) internal {
        if (ok) {
            console2.log(string.concat("  [ok]   ", what));
        } else {
            failures++;
            console2.log(string.concat("  [FAIL] ", what));
        }
    }
}
