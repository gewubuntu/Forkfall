// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Fixture} from "./Fixture.sol";
import {PackSale} from "../src/PackSale.sol";
import {VRFCoordinatorMock} from "../src/vrf/VRFCoordinatorMock.sol";

contract VrfTest is Fixture {
    VRFCoordinatorMock vrf;
    uint32 constant GAS_PER_PACK = 30_000;

    function config(address coordinator) internal pure returns (PackSale.VrfConfig memory) {
        return PackSale.VrfConfig({
            coordinator: coordinator,
            keyHash: bytes32(uint256(1)),
            subId: 7,
            confirmations: 3,
            callbackGasPerPack: GAS_PER_PACK,
            nativePayment: false
        });
    }

    function setUp() public override {
        super.setUp();
        vrf = new VRFCoordinatorMock();
        PackSale.VrfConfig memory c = config(address(vrf));
        vm.prank(admin);
        d.packs.setVrf(c);
        vm.deal(alice, 100 ether);
    }

    function buy(address who, uint256 n) internal returns (uint256 first) {
        uint256 price = d.packs.quoteEth(n); // before the prank, which the next call consumes
        vm.prank(who);
        first = d.packs.buyWithEthOf{value: price}(0, n);
    }

    function fulfillAll() internal returns (bool allOk) {
        vm.recordLogs();
        while (vrf.pending() > 0) {
            vrf.fulfillPending();
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RandomWordsFulfilled(uint256,bool)");
        allOk = true;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig && !abi.decode(logs[i].data, (bool))) allOk = false;
        }
    }

    function openAs(address who, uint256 id) internal returns (uint256[5] memory) {
        vm.prank(who);
        return d.packs.open(id);
    }

    function test_packWaitsForItsWordThenOpensExactlyAsPreviewed() public {
        uint256 id = buy(alice, 1);
        assertFalse(d.packs.packReady(id));
        vm.roll(block.number + 50); // block height alone no longer opens it
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.RandomnessPending.selector, id));
        d.packs.open(id);

        assertTrue(fulfillAll());
        assertTrue(d.packs.packReady(id));
        (uint256 next, uint256[5] memory preview) = d.packs.previewVrfOpen(alice);
        assertEq(next, id);
        uint256[5] memory got = openAs(alice, id);
        for (uint256 i; i < 5; ++i) {
            assertEq(got[i], preview[i]);
            assertGt(d.cards.balanceOf(alice, got[i]), 0);
        }
    }

    function test_theCallbackOnlyStoresWordsSoAFullCollectionCantMakeItFail() public {
        // Alice holds 2 of every card, the worst case for duplicate protection; a 10-pack bundle still fulfills.
        bytes32 minter = d.cards.MINTER_ROLE();
        vm.prank(admin);
        d.cards.grantRole(minter, address(this));
        uint256[] memory all = d.cards.allCards();
        uint256[] memory twos = new uint256[](all.length);
        for (uint256 i; i < all.length; ++i) {
            twos[i] = 2;
        }
        d.cards.mintBatch(alice, all, twos);
        uint256 first = buy(alice, 10);
        assertTrue(fulfillAll(), "callback ran out of gas");
        for (uint256 i; i < 10; ++i) {
            assertGt(d.packs.vrfWordOf(first + i), 0);
        }
        openAs(alice, first); // opening (paid by the player) handles the full collection
    }

    function test_vrfPacksOpenOldestFirst() public {
        uint256 first = buy(alice, 2);
        fulfillAll();
        assertFalse(d.packs.packReady(first + 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.OpenInOrder.selector, first));
        d.packs.open(first + 1);
        openAs(alice, first);
        assertTrue(d.packs.packReady(first + 1));
        openAs(alice, first + 1);
        assertEq(d.packs.nextVrfPack(alice), type(uint256).max);
    }

    function test_movingCardsAwayDoesNotChangeWhatAPackHolds() public {
        uint256 first = buy(alice, 2);
        fulfillAll();
        uint256[5] memory one = openAs(alice, first);
        (, uint256[5] memory before) = d.packs.previewVrfOpen(alice);
        // Alice moves everything from the first pack to Bob: duplicate protection counts pulls, not holdings.
        for (uint256 i; i < 5; ++i) {
            uint256 bal = d.cards.balanceOf(alice, one[i]);
            if (bal > 0) {
                vm.prank(alice);
                d.cards.safeTransferFrom(alice, bob, one[i], bal, "");
            }
        }
        (, uint256[5] memory afterMove) = d.packs.previewVrfOpen(alice);
        uint256[5] memory got = openAs(alice, first + 1);
        for (uint256 i; i < 5; ++i) {
            assertEq(afterMove[i], before[i]);
            assertEq(got[i], before[i]);
        }
    }

    function test_duplicateProtectionCountsPulls() public {
        uint256 first = buy(alice, 10);
        fulfillAll();
        uint256 total;
        for (uint256 i; i < 10; ++i) {
            openAs(alice, first + i);
        }
        uint256[] memory all = d.cards.allCards();
        for (uint256 i; i < all.length; ++i) {
            total += d.packs.pulled(alice, all[i]);
        }
        assertEq(total, 50);
    }

    function test_onlyTheRequestsCoordinatorAnswers() public {
        uint256 id = buy(alice, 1);
        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        vm.prank(alice); // the right request id, the wrong caller: nothing happens
        d.packs.rawFulfillRandomWords(1, words);
        vm.prank(alice);
        d.packs.rawFulfillRandomWords(999, words);
        assertEq(d.packs.vrfWordOf(id), 0);
        fulfillAll();
        assertGt(d.packs.vrfWordOf(id), 0);
    }

    function test_twoCoordinatorsReusingARequestIdDontCollide() public {
        uint256 p1 = buy(alice, 1); // mock 1, request id 1
        VRFCoordinatorMock second = new VRFCoordinatorMock();
        PackSale.VrfConfig memory c = config(address(second));
        vm.prank(admin);
        d.packs.setVrf(c);
        uint256 p2 = buy(alice, 1); // mock 2, also request id 1
        vrf.fulfillPending();
        second.fulfillPending();
        assertGt(d.packs.vrfWordOf(p1), 0);
        assertGt(d.packs.vrfWordOf(p2), 0);
        openAs(alice, p1);
        openAs(alice, p2);
    }

    function test_blockhashPacksCantSteerAVrfPack() public {
        // Alice holds a blockhash pack from before VRF, and a VRF pack whose word is public.
        PackSale.VrfConfig memory off;
        vm.prank(admin);
        d.packs.setVrf(off);
        uint256 old = buy(alice, 1);
        PackSale.VrfConfig memory on = config(address(vrf));
        vm.prank(admin);
        d.packs.setVrf(on);
        uint256 id = buy(alice, 1);
        fulfillAll();
        (, uint256[5] memory before) = d.packs.previewVrfOpen(alice);
        uint256 vrfPity = d.packs.vrfPacksSinceLegendary(alice);
        // Opening the blockhash pack first touches neither the VRF pity counter nor `pulled`.
        vm.roll(block.number + 3);
        openAs(alice, old);
        assertEq(d.packs.vrfPacksSinceLegendary(alice), vrfPity);
        (, uint256[5] memory afterOld) = d.packs.previewVrfOpen(alice);
        uint256[5] memory got = openAs(alice, id);
        for (uint256 i; i < 5; ++i) {
            assertEq(afterOld[i], before[i]);
            assertEq(got[i], before[i]);
        }
    }

    function test_openingWithALongPullHistoryStaysAffordable() public {
        // 100 packs pulled: duplicate protection walks most pools; opening must stay well under a block's budget.
        for (uint256 b; b < 10; ++b) {
            uint256 first = buy(alice, 10);
            fulfillAll();
            for (uint256 i; i < 10; ++i) {
                openAs(alice, first + i);
            }
        }
        uint256 last = buy(alice, 1);
        fulfillAll();
        vm.prank(alice);
        uint256 g = gasleft();
        d.packs.open(last);
        // Worst case: every pool is walked in full, so the cost grows with the set (about 1.25M gas with the
        // 168 cards of Set 1 and Poncho, a small share of a Base block).
        assertLt(g - gasleft(), 1_500_000);
    }

    function test_retryNeverSwapsAWordTheFirstAnswerWins() public {
        uint256 id = buy(alice, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.NotRetryable.selector, id));
        d.packs.retryRandomness(id);
        vm.roll(block.number + d.packs.VRF_RETRY_BLOCKS());
        vm.prank(bob);
        vm.expectRevert(PackSale.NotOwner.selector);
        d.packs.retryRandomness(id);
        vm.prank(alice);
        d.packs.retryRandomness(id);
        vm.recordLogs();
        vrf.fulfillPending(); // answers the original request, then the retry
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 seeded = keccak256("PackSeeded(uint256,uint256)");
        uint256 n;
        uint256 word;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == seeded) {
                n++;
                (word) = abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(n, 1);
        assertEq(d.packs.vrfWordOf(id), word);
        openAs(alice, id);
    }

    function test_switchingVrfOffReSealsOnlyAfterTheRetryWindowAndNeverBlocksTheQueue() public {
        uint256 first = buy(alice, 2);
        PackSale.VrfConfig memory off;
        vm.prank(admin);
        d.packs.setVrf(off);
        // An answer may still be on its way: no dodging it by re-sealing right away.
        assertFalse(d.packs.packReady(first));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.RandomnessPending.selector, first));
        d.packs.open(first);
        vm.roll(block.number + d.packs.VRF_RETRY_BLOCKS());
        assertTrue(d.packs.packReady(first));
        uint256[5] memory none = openAs(alice, first);
        assertEq(none[0], 0);
        assertEq(d.packs.vrfRequestOf(first), 0);
        // The next VRF pack is now first in line; re-seal it too, then both open from blockhashes.
        uint256[5] memory none2 = openAs(alice, first + 1);
        assertEq(none2[0], 0);
        vm.roll(block.number + 3);
        assertGt(openAs(alice, first)[0], 0);
        assertGt(openAs(alice, first + 1)[0], 0);
        vrf.fulfillPending(); // late answers no longer touch them
        assertEq(d.packs.vrfWordOf(first), 0);
    }

    function test_theOldCoordinatorsAnswerStillCountsAfterSwitching() public {
        uint256 id = buy(alice, 1);
        VRFCoordinatorMock next = new VRFCoordinatorMock();
        PackSale.VrfConfig memory c = config(address(next));
        vm.prank(admin);
        d.packs.setVrf(c);
        vrf.fulfillPending();
        assertGt(d.packs.vrfWordOf(id), 0);
        openAs(alice, id);
    }

    function test_freeQuestPacksUseVrfToo() public {
        vm.prank(referee);
        d.quests.reward(alice, keccak256("pack"), 0, 1, 1);
        uint256 id = d.packs.packCount() - 1;
        assertGt(d.packs.vrfRequestOf(id), 0);
        assertFalse(d.packs.packReady(id));
        fulfillAll();
        openAs(alice, id);
    }

    function test_onlyTheRandomnessAdminSwitchesTheSource() public {
        PackSale.VrfConfig memory off;
        vm.prank(alice);
        vm.expectRevert();
        d.packs.setVrf(off);
        vm.prank(admin);
        d.packs.setVrf(off);
        uint256 id = buy(alice, 1);
        assertEq(d.packs.vrfRequestOf(id), 0);
        vm.roll(block.number + 3);
        assertTrue(d.packs.packReady(id));
        openAs(alice, id);
    }
}
