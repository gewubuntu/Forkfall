// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {StarterDecks} from "../src/StarterDecks.sol";
import {PackSale} from "../src/PackSale.sol";
import {Crafting} from "../src/Crafting.sol";
import {QuestRewards} from "../src/QuestRewards.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {HumanRegistry} from "../src/HumanRegistry.sol";
import {DeckRegistry} from "../src/DeckRegistry.sol";
import {MatchSettlement, ILeague} from "../src/MatchSettlement.sol";
import {SeasonRewards} from "../src/SeasonRewards.sol";
import {AgentLeague, IEloTable} from "../src/AgentLeague.sol";
import {FaucetToken} from "../src/TestTokens.sol";
import {Set1Cards} from "../src/generated/Set1Cards.sol";

/// @notice Deploys the full Forkfall hub. The hub chain is Base Sepolia (84532); Robinhood Chain testnet
///         can host its own CardRegistry/PackSale set with the same script.
///
///   pnpm deploy:base-sepolia        (keystore account, broadcast + Basescan verification)
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify --account forkfall-deployer
///
/// Env: REFEREE_ADDRESS  server key (REFEREE_ROLE) that co-signs ranked results; defaults to the deployer
///      TREASURY_ADDRESS receives pack sale proceeds; defaults to the deployer
///      METADATA_BASE    where card metadata is served: the referee server's /metadata
///                       (https://<server>/metadata) or a pinned `pnpm art:export` folder (ipfs://<cid>);
///                       defaults to http://localhost:8787/metadata on Anvil
///      CARD_URI / CONTRACT_URI  override the derived <base>/cards/{id}.json and <base>/contract.json
///      PACK_PRICE_WEI   pack price in wei
contract Deploy is ForkfallScript {
    struct Deployed {
        CardRegistry cards;
        StarterDecks starters;
        PackSale packs;
        Crafting crafting;
        QuestRewards quests;
        AgentRegistry agents;
        HumanRegistry humans;
        DeckRegistry decks;
        MatchSettlement settlement;
        SeasonRewards rewards;
        AgentLeague league;
        FaucetToken usdc;
        FaucetToken fall;
    }

    function run() external returns (Deployed memory d) {
        requireTestnet();
        address deployer = msg.sender;
        address referee = vm.envOr("REFEREE_ADDRESS", deployer);
        address payable treasury = payable(vm.envOr("TREASURY_ADDRESS", deployer));
        string memory base =
            vm.envOr("METADATA_BASE", block.chainid == 31337 ? string("http://localhost:8787/metadata") : string(""));
        string memory uri =
            vm.envOr("CARD_URI", bytes(base).length > 0 ? string.concat(base, "/cards/{id}.json") : string(""));
        string memory contractUri =
            vm.envOr("CONTRACT_URI", bytes(base).length > 0 ? string.concat(base, "/contract.json") : string(""));
        require(
            bytes(uri).length > 0,
            "Set METADATA_BASE (https://<referee server>/metadata or ipfs://<cid> from pnpm art:export) or CARD_URI"
        );
        uint256 packPrice = vm.envOr("PACK_PRICE_WEI", uint256(0.0001 ether));

        console2.log("Deploying Forkfall hub to chain", block.chainid);
        console2.log("  deployer", deployer);
        console2.log("  referee ", referee);
        console2.log("  treasury", treasury);
        console2.log("  card URI", uri);

        uint256 startBlock = block.number;
        vm.startBroadcast();
        d = deployAll(deployer, referee, uri, packPrice);
        if (treasury != deployer) d.packs.setTreasury(treasury);
        if (bytes(contractUri).length > 0) d.cards.setContractURI(contractUri);
        vm.stopBroadcast();

        writeBook(d, deployer, referee, startBlock);
        logExplorer(d);
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
        d.crafting = new Crafting(d.cards, admin);
        // Daily quests: the referee pays Scrap and free packs through QuestRewards (capped, one payout per claim id).
        d.quests = new QuestRewards(admin, d.crafting, d.packs, referee);
        d.agents = new AgentRegistry(admin);
        d.humans = new HumanRegistry(admin);
        d.decks = new DeckRegistry(d.cards);
        d.settlement = new MatchSettlement(admin, d.agents, d.decks);
        d.rewards = new SeasonRewards(admin);
        d.usdc = new FaucetToken("Forkfall Test USDC", "tUSDC", 6, 100e6, admin);
        d.fall = new FaucetToken("Forkfall Test Token", "tFALL", 18, 1_000 ether, admin);
        // Agent League: 0.50 tUSDC per agent per match; 80% weekly pot, 10% buyback, 10% operations.
        d.league =
            new AgentLeague(admin, d.usdc, d.agents, IEloTable(address(d.settlement)), referee, admin, admin, 0.5e6);
        d.league.setSettlement(address(d.settlement));
        d.settlement.setLeague(ILeague(address(d.league)));

        d.cards.grantRole(d.cards.MINTER_ROLE(), address(d.starters));
        d.cards.grantRole(d.cards.MINTER_ROLE(), address(d.packs));
        d.cards.grantRole(d.cards.MINTER_ROLE(), address(d.crafting));
        d.cards.grantRole(d.cards.BURNER_ROLE(), address(d.crafting));
        d.crafting.grantRole(d.crafting.SCRAP_GRANTER_ROLE(), address(d.quests));
        d.packs.grantRole(d.packs.PACK_GRANTER_ROLE(), address(d.quests));
        d.settlement.grantRole(d.settlement.REFEREE_ROLE(), referee);
        // Testnet human verification: the referee attests with the labeled "testnet" method until a real
        // proof-of-personhood provider (Human Passport, Coinbase Verifications, World ID) is plugged in.
        d.humans.setMethod(keccak256("testnet"), true);
        d.humans.grantRole(d.humans.ATTESTOR_ROLE(), referee);
        d.packs.setTokenPrice(address(d.usdc), 2e6);
        d.packs.setTokenPrice(address(d.fall), 100 ether);
        d.packs.setKind(1, "Poncho booster", Set1Cards.poncho());
    }

    function writeBook(Deployed memory d, address deployer, address referee, uint256 startBlock) internal {
        string memory k = "book";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", startBlock);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "referee", referee);
        vm.serializeAddress(k, "CardRegistry", address(d.cards));
        vm.serializeAddress(k, "StarterDecks", address(d.starters));
        vm.serializeAddress(k, "PackSale", address(d.packs));
        vm.serializeAddress(k, "Crafting", address(d.crafting));
        vm.serializeAddress(k, "QuestRewards", address(d.quests));
        vm.serializeAddress(k, "AgentRegistry", address(d.agents));
        vm.serializeAddress(k, "HumanRegistry", address(d.humans));
        vm.serializeAddress(k, "DeckRegistry", address(d.decks));
        vm.serializeAddress(k, "MatchSettlement", address(d.settlement));
        vm.serializeAddress(k, "SeasonRewards", address(d.rewards));
        vm.serializeAddress(k, "AgentLeague", address(d.league));
        vm.serializeAddress(k, "TestUSDC", address(d.usdc));
        string memory json = vm.serializeAddress(k, "TestFALL", address(d.fall));
        vm.writeJson(json, bookPath());
        console2.log("Address book written to", bookPath());
    }

    function logExplorer(Deployed memory d) internal view {
        string memory ex = block.chainid == 84532
            ? "https://sepolia.basescan.org/address/"
            : block.chainid == 46630 ? "https://explorer.testnet.chain.robinhood.com/address/" : "";
        if (bytes(ex).length == 0) return;
        console2.log("Explorer:");
        console2.log(string.concat("  MatchSettlement ", ex, vm.toString(address(d.settlement))));
        console2.log(string.concat("  CardRegistry    ", ex, vm.toString(address(d.cards))));
        console2.log(string.concat("  PackSale        ", ex, vm.toString(address(d.packs))));
        console2.log(string.concat("  DeckRegistry    ", ex, vm.toString(address(d.decks))));
    }
}
