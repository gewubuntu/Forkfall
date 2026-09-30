// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {StarterDecks} from "../src/StarterDecks.sol";
import {PackSale} from "../src/PackSale.sol";
import {Crafting} from "../src/Crafting.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {DeckRegistry} from "../src/DeckRegistry.sol";
import {MatchSettlement} from "../src/MatchSettlement.sol";
import {SeasonRewards} from "../src/SeasonRewards.sol";
import {FaucetToken} from "../src/TestTokens.sol";

abstract contract Fixture is Test {
    Deploy.Deployed d;
    address admin;
    uint256 refereePk = 0x5EF;
    address referee = vm.addr(0x5EF);
    uint256 alicePk = 0xA11CE;
    uint256 bobPk = 0xB0B;
    address alice;
    address bob;

    function setUp() public virtual {
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        Deploy deployer = new Deploy();
        admin = address(deployer);
        d = deployer.deployAll(admin, referee, "ipfs://cards/{id}.json", 0.0001 ether);
        vm.prank(admin);
        d.packs.setTreasury(payable(makeAddr("treasury")));
    }

    function starterIds(uint8 race) internal view returns (uint16[] memory ids) {
        uint16[30] memory s = d.starters.starterList(race);
        ids = new uint16[](30);
        for (uint256 i; i < 30; ++i) {
            ids[i] = s[i];
        }
    }

    function claimAndRegister(address who, uint8 race) internal returns (bytes32 deckId) {
        vm.startPrank(who);
        d.starters.claim(race);
        deckId = d.decks.register(race, starterIds(race));
        vm.stopPrank();
    }
}
