// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {ForkfallScript} from "./Base.s.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {StarterDecks} from "../src/StarterDecks.sol";
import {PackSale} from "../src/PackSale.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {DeckRegistry} from "../src/DeckRegistry.sol";
import {MatchSettlement} from "../src/MatchSettlement.sol";
import {FaucetToken} from "../src/TestTokens.sol";

/// Player-side on-chain actions, all via Foundry. Examples (Base Sepolia):
///   forge script script/Play.s.sol --sig "claimStarter(uint8)" 1 --rpc-url base_sepolia --broadcast --private-key $PK
///   forge script script/Play.s.sol --sig "registerStarterDeck(uint8)" 1 ...
///   forge script script/Play.s.sol --sig "buyPacks(uint256)" 2 ...
///   forge script script/Play.s.sol --sig "openPack(uint256)" 0 ...
///   forge script script/Play.s.sol --sig "registerAgent(string,string)" "my-bot" "What it plays and how" ...
///   forge script script/Play.s.sol --sig "settle(string)" settlements/<matchId>.json ...
///   forge script script/Play.s.sol --sig "status(address)" $ME --rpc-url base_sepolia
contract Play is ForkfallScript {
    function claimStarter(uint8 race) external {
        requireTestnet();
        vm.startBroadcast();
        StarterDecks(addr("StarterDecks")).claim(race);
        vm.stopBroadcast();
    }

    /// @notice Registers the free starter deck of `race` for the broadcaster; prints the deck id for queueing.
    function registerStarterDeck(uint8 race) external returns (bytes32 deckId) {
        requireTestnet();
        uint16[30] memory s = StarterDecks(addr("StarterDecks")).starterList(race);
        uint16[] memory ids = new uint16[](30);
        for (uint256 i; i < 30; ++i) {
            ids[i] = s[i];
        }
        vm.startBroadcast();
        deckId = DeckRegistry(addr("DeckRegistry")).register(race, ids);
        vm.stopBroadcast();
        console2.log("deckId:");
        console2.logBytes32(deckId);
    }

    /// @notice Registers a custom deck given as a comma-separated list of 30 sorted card ids.
    function registerDeck(uint8 race, uint16[] calldata ids) external returns (bytes32 deckId) {
        requireTestnet();
        vm.startBroadcast();
        deckId = DeckRegistry(addr("DeckRegistry")).register(race, ids);
        vm.stopBroadcast();
        console2.logBytes32(deckId);
    }

    function buyPacks(uint256 count) external returns (uint256 firstId) {
        requireTestnet();
        PackSale sale = PackSale(addr("PackSale"));
        vm.startBroadcast();
        firstId = sale.buyWithEth{value: sale.quoteEth(count)}(count);
        vm.stopBroadcast();
        console2.log("first pack id:", firstId, "count:", count);
    }

    function buyPacksWithTestUsdc(uint256 count) external returns (uint256 firstId) {
        requireTestnet();
        PackSale sale = PackSale(addr("PackSale"));
        FaucetToken usdc = FaucetToken(addr("TestUSDC"));
        vm.startBroadcast();
        usdc.approve(address(sale), sale.tokenPrice(address(usdc)) * count);
        firstId = sale.buyWithToken(address(usdc), count);
        vm.stopBroadcast();
        console2.log("first pack id:", firstId);
    }

    function dripTestUsdc() external {
        requireTestnet();
        vm.startBroadcast();
        FaucetToken(addr("TestUSDC")).drip();
        vm.stopBroadcast();
    }

    function openPack(uint256 packId) external returns (uint256[5] memory ids) {
        requireTestnet();
        PackSale sale = PackSale(addr("PackSale"));
        require(
            sale.packReady(packId),
            "pack not ready: its randomness isn't in yet (Chainlink VRF answers within a minute, or the reveal block is still ahead); try again shortly"
        );
        vm.startBroadcast();
        ids = sale.open(packId);
        vm.stopBroadcast();
        for (uint256 i; i < 5; ++i) {
            console2.log("card", ids[i]);
        }
    }

    /// @notice Registers the broadcasting wallet as a self-owned agent (ERC-8004): it owns its own agent NFT and
    ///         plays as the agent wallet. The registration file is stored on-chain as a base64 data URI.
    ///         Operators who want to own their agents register them on the Profile page instead.
    function registerAgent(string calldata name, string calldata description) external returns (uint256 agentId) {
        requireTestnet();
        AgentRegistry reg = AgentRegistry(addr("AgentRegistry"));
        uint256 next = reg.nextAgentId();
        string memory json = string.concat(
            '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"',
            name,
            '","description":"',
            description,
            '","image":"","services":[],"active":true,"registrations":[{"agentId":',
            vm.toString(next),
            ',"agentRegistry":"eip155:',
            vm.toString(block.chainid),
            ":",
            vm.toString(address(reg)),
            '"}],"supportedTrust":[]}'
        );
        vm.startBroadcast();
        agentId = reg.register(string.concat("data:application/json;base64,", Base64.encode(bytes(json))));
        vm.stopBroadcast();
        console2.log("agentId:", agentId);
    }

    /// @notice Submit a settlement file exported by the match server (GET /v1/matches/:id/settlement).
    function settle(string calldata file) external {
        requireTestnet();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/", file));
        MatchSettlement.MatchResult memory r = MatchSettlement.MatchResult({
            matchId: vm.parseJsonBytes32(json, ".result.matchId"),
            playerA: vm.parseJsonAddress(json, ".result.playerA"),
            playerB: vm.parseJsonAddress(json, ".result.playerB"),
            winner: vm.parseJsonAddress(json, ".result.winner"),
            deckA: vm.parseJsonBytes32(json, ".result.deckA"),
            deckB: vm.parseJsonBytes32(json, ".result.deckB"),
            mode: uint8(vm.parseJsonUint(json, ".result.mode")),
            season: uint32(vm.parseJsonUint(json, ".result.season")),
            turns: uint16(vm.parseJsonUint(json, ".result.turns")),
            logHash: vm.parseJsonBytes32(json, ".result.logHash")
        });
        bool byReferee = vm.parseJsonBool(json, ".byReferee");
        MatchSettlement ms = MatchSettlement(addr("MatchSettlement"));
        vm.startBroadcast();
        if (byReferee) {
            ms.settleByReferee(r, vm.parseJsonBytes(json, ".winnerSig"));
        } else {
            ms.settle(
                r,
                vm.parseJsonBytes(json, ".sigA"),
                vm.parseJsonBytes(json, ".sigB"),
                vm.parseJsonBytes(json, ".refereeSig")
            );
        }
        vm.stopBroadcast();
        console2.log("settled match");
        console2.logBytes32(r.matchId);
    }

    function status(address player) external view {
        CardRegistry cards = CardRegistry(addr("CardRegistry"));
        MatchSettlement ms = MatchSettlement(addr("MatchSettlement"));
        uint32 season = ms.currentSeason();
        MatchSettlement.Stats memory s = ms.stats(season, player);
        console2.log("season", season);
        console2.log("rating", s.rating);
        console2.log("wins/losses/draws", s.wins, s.losses, s.draws);
        uint256[] memory ids = cards.allCards();
        for (uint256 i; i < ids.length; ++i) {
            uint256 b = cards.playableBalance(player, ids[i]);
            if (b > 0) console2.log("card", ids[i], "x", b);
        }
    }
}
