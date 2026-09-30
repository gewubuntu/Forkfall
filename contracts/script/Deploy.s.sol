// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
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
import {Set1Cards} from "../src/generated/Set1Cards.sol";

/// @notice Deploys the full Forkfall hub to a testnet (Base Sepolia is the hub; Robinhood Chain testnet
///         can host its own CardRegistry/PackSale set with the same script).
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_KEY
///
/// Env: REFEREE_ADDRESS (server key allowed to settle disputes; defaults to deployer),
///      CARD_URI (ERC-1155 metadata template), PACK_PRICE_WEI.
contract Deploy is ForkfallScript {
    struct Deployed {
        CardRegistry cards;
        StarterDecks starters;
        PackSale packs;
        Crafting crafting;
        AgentRegistry agents;
        HumanRegistry humans;
        DeckRegistry decks;
        MatchSettlement settlement;
        SeasonRewards rewards;
        FaucetToken usdc;
        FaucetToken fall;
    }

    function run() external returns (Deployed memory d) {
        requireTestnet();
        address deployer = msg.sender;
        address referee = vm.envOr("REFEREE_ADDRESS", deployer);
        string memory uri = vm.envOr("CARD_URI", string("https://forkfall.example/cards/{id}.json"));
        uint256 packPrice = vm.envOr("PACK_PRICE_WEI", uint256(0.0001 ether));

        vm.startBroadcast();
        d = deployAll(deployer, referee, uri, packPrice);
        vm.stopBroadcast();

        writeBook(d, referee);
    }

    function deployAll(address admin, address referee, string memory uri, uint256 packPrice)
        public
        returns (Deployed memory d)
    {
        d.cards = new CardRegistry(admin, uri);
        (uint16[] memory ids, uint8[] memory races, uint8[] memory rarities, uint8[] memory chains) = Set1Cards.all();
        d.cards.defineCards(ids, races, rarities, chains);

        d.starters = new StarterDecks(d.cards);
        d.packs = new PackSale(d.cards, admin, payable(admin), packPrice);
        d.crafting = new Crafting(d.cards);
        d.agents = new AgentRegistry(admin);
        d.humans = new HumanRegistry(admin);
        d.decks = new DeckRegistry(d.cards);
        d.settlement = new MatchSettlement(admin, d.agents, d.decks, d.humans);
        d.rewards = new SeasonRewards(admin);
        d.usdc = new FaucetToken("Forkfall Test USDC", "tUSDC", 6, 100e6, admin);
        d.fall = new FaucetToken("Forkfall Test Token", "tFALL", 18, 1_000 ether, admin);

        d.cards.grantRole(d.cards.MINTER_ROLE(), address(d.starters));
        d.cards.grantRole(d.cards.MINTER_ROLE(), address(d.packs));
        d.cards.grantRole(d.cards.MINTER_ROLE(), address(d.crafting));
        d.cards.grantRole(d.cards.BURNER_ROLE(), address(d.crafting));
        d.settlement.grantRole(d.settlement.REFEREE_ROLE(), referee);
        d.packs.setTokenPrice(address(d.usdc), 2e6);
        d.packs.setTokenPrice(address(d.fall), 100 ether);
    }

    function writeBook(Deployed memory d, address referee) internal {
        string memory k = "book";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "referee", referee);
        vm.serializeAddress(k, "CardRegistry", address(d.cards));
        vm.serializeAddress(k, "StarterDecks", address(d.starters));
        vm.serializeAddress(k, "PackSale", address(d.packs));
        vm.serializeAddress(k, "Crafting", address(d.crafting));
        vm.serializeAddress(k, "AgentRegistry", address(d.agents));
        vm.serializeAddress(k, "HumanRegistry", address(d.humans));
        vm.serializeAddress(k, "DeckRegistry", address(d.decks));
        vm.serializeAddress(k, "MatchSettlement", address(d.settlement));
        vm.serializeAddress(k, "SeasonRewards", address(d.rewards));
        vm.serializeAddress(k, "TestUSDC", address(d.usdc));
        string memory json = vm.serializeAddress(k, "TestFALL", address(d.fall));
        vm.writeJson(json, bookPath());
        console2.log("Address book written to", bookPath());
    }
}
