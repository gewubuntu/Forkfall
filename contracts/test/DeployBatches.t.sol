// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ForkfallScript} from "../script/Base.s.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {Set1Cards} from "../src/generated/Set1Cards.sol";

contract BatchHarness is ForkfallScript {
    function defineBatched(
        CardRegistry cards,
        uint16[] memory ids,
        uint8[] memory r,
        uint8[] memory rar,
        uint8[] memory ch
    ) external {
        defineCardsInBatches(cards, ids, r, rar, ch);
    }

    function batchSize() external pure returns (uint256) {
        return CARD_BATCH;
    }
}

/// Base (like Ethereum since Fusaka, EIP-7825) rejects any transaction asking for more than 2^24 gas, and forge
/// asks for its estimate plus 30%. Defining all of Set 1 in one transaction measured 12.3M gas: over the cap.
contract DeployBatchesTest is Test {
    uint256 constant TX_GAS_CAP = 16_777_216;

    function test_deployDefinesEveryCardInSeveralTransactions() public {
        (uint16[] memory ids,,,) = Set1Cards.all();
        BatchHarness h = new BatchHarness();
        uint256 batches = (ids.length + h.batchSize() - 1) / h.batchSize();
        assertGt(batches, 1);

        Deploy deployer = new Deploy();
        address cards = vm.computeCreateAddress(address(deployer), 1); // deployAll creates CardRegistry first
        vm.expectCall(cards, abi.encodeWithSelector(CardRegistry.defineCards.selector), uint64(batches));
        Deploy.Deployed memory d = deployer.deployAll(address(deployer), address(0x5EF), "ipfs://c/{id}.json", 1);

        assertEq(address(d.cards), cards);
        uint256[] memory all = d.cards.allCards();
        assertEq(all.length, ids.length);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(all[i], ids[i]);
        }
    }

    function test_fullBatchFitsUnderTheTransactionCapWithForgeMargin() public {
        BatchHarness h = new BatchHarness();
        CardRegistry cards = new CardRegistry(address(h), "ipfs://c/{id}.json");
        (uint16[] memory ids, uint8[] memory races, uint8[] memory rarities, uint8[] memory chains) = Set1Cards.all();
        uint256 n = h.batchSize();
        assertLe(n, ids.length);
        (uint16[] memory bIds, uint8[] memory bRaces, uint8[] memory bRarities, uint8[] memory bChains) =
            (new uint16[](n), new uint8[](n), new uint8[](n), new uint8[](n));
        for (uint256 i; i < n; ++i) {
            (bIds[i], bRaces[i], bRarities[i], bChains[i]) = (ids[i], races[i], rarities[i], chains[i]);
        }
        uint256 before = gasleft();
        h.defineBatched(cards, bIds, bRaces, bRarities, bChains); // exactly one full batch: one transaction on-chain
        uint256 used = before - gasleft();
        assertLt(used * 13 / 10, TX_GAS_CAP / 2); // forge's 30% margin, and still half the cap to spare
    }
}
