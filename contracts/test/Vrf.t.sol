// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {PackSale} from "../src/PackSale.sol";
import {VRFCoordinatorMock} from "../src/vrf/VRFCoordinatorMock.sol";

contract VrfTest is Fixture {
    VRFCoordinatorMock vrf;

    function setUp() public override {
        super.setUp();
        vrf = new VRFCoordinatorMock();
        PackSale.VrfConfig memory c = PackSale.VrfConfig({
            coordinator: address(vrf),
            keyHash: bytes32(uint256(1)),
            subId: 7,
            confirmations: 3,
            callbackGasPerPack: 30_000,
            nativePayment: false
        });
        vm.prank(admin);
        d.packs.setVrf(c);
        vm.deal(alice, 1 ether);
    }

    function buy(address who, uint256 n) internal returns (uint256 first) {
        uint256 price = d.packs.quoteEth(n); // before the prank, which the next call consumes
        vm.prank(who);
        first = d.packs.buyWithEthOf{value: price}(0, n);
    }

    function test_packWaitsForTheVrfWordThenOpensWithThatWord() public {
        uint256 id = buy(alice, 1);
        assertEq(d.packs.vrfRequestOf(id), 1);
        assertFalse(d.packs.packReady(id));
        vm.roll(block.number + 50); // block height alone no longer opens it
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.RandomnessPending.selector, id));
        d.packs.open(id);

        vrf.fulfillPending();
        assertTrue(d.packs.packReady(id));
        uint256 word = d.packs.vrfWordOf(id);
        assertGt(word, 0);
        uint256[5] memory expected =
            d.packs.roll(keccak256(abi.encode(bytes32(word), id, alice, address(d.packs))), alice, false, 0);
        vm.prank(alice);
        uint256[5] memory got = d.packs.open(id);
        for (uint256 i; i < 5; ++i) {
            assertEq(got[i], expected[i]);
        }
        assertFalse(d.packs.packReady(id)); // opened
    }

    function test_onlyTheCoordinatorDeliversWords() public {
        uint256 id = buy(alice, 1);
        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.OnlyCoordinator.selector, alice, address(vrf)));
        d.packs.rawFulfillRandomWords(1, words);
        assertEq(d.packs.vrfWordOf(id), 0);
    }

    function test_aBundleGetsOneWordPerPack() public {
        uint256 first = buy(alice, 5);
        vrf.fulfillPending();
        for (uint256 i; i < 5; ++i) {
            assertEq(d.packs.vrfRequestOf(first + i), 1);
            for (uint256 j; j < i; ++j) {
                assertTrue(d.packs.vrfWordOf(first + i) != d.packs.vrfWordOf(first + j));
            }
        }
    }

    function test_unansweredRequestCanBeRetriedAfterTimeoutAndStaleAnswersAreIgnored() public {
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
        assertEq(d.packs.vrfRequestOf(id), 2);
        // The coordinator answers both: the first (stale) answer is ignored, the retry seeds the pack.
        vrf.fulfillPending();
        assertTrue(d.packs.packReady(id));
        vm.prank(alice);
        d.packs.open(id);
    }

    function test_freeQuestPacksUseVrfToo() public {
        vm.prank(referee);
        d.quests.reward(alice, keccak256("pack"), 0, 1, 1);
        uint256 id = d.packs.packCount() - 1;
        assertGt(d.packs.vrfRequestOf(id), 0);
        assertFalse(d.packs.packReady(id));
        vrf.fulfillPending();
        vm.prank(alice);
        d.packs.open(id);
    }

    function test_onlyTheRandomnessAdminSwitchesTheSource() public {
        PackSale.VrfConfig memory off;
        vm.prank(alice);
        vm.expectRevert();
        d.packs.setVrf(off);
        vm.prank(admin);
        d.packs.setVrf(off);
        // Back to blockhash: packs bought now open after their reveal block, with no VRF request.
        uint256 id = buy(alice, 1);
        assertEq(d.packs.vrfRequestOf(id), 0);
        vm.roll(block.number + 3);
        assertTrue(d.packs.packReady(id));
        vm.prank(alice);
        d.packs.open(id);
    }
}
