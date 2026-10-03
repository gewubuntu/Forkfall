// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Fixture} from "./Fixture.sol";
import {PackSale} from "../src/PackSale.sol";
import {VRFCoordinatorMock} from "../src/vrf/VRFCoordinatorMock.sol";

contract VrfTest is Fixture {
    VRFCoordinatorMock vrf;
    uint32 constant GAS_PER_PACK = 150_000;

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
        vm.deal(alice, 10 ether);
    }

    function buy(address who, uint256 n) internal returns (uint256 first) {
        uint256 price = d.packs.quoteEth(n); // before the prank, which the next call consumes
        vm.prank(who);
        first = d.packs.buyWithEthOf{value: price}(0, n);
    }

    function contents(uint256 packId) internal view returns (uint256[5] memory ids) {
        uint256 rolled = d.packs.rolledOf(packId);
        for (uint256 i; i < 5; ++i) {
            ids[i] = (rolled >> (32 * i)) & type(uint32).max;
        }
    }

    function test_contentsAreFixedWhenTheWordArrivesAndOpeningOnlyMintsThem() public {
        uint256 id = buy(alice, 1);
        assertFalse(d.packs.packReady(id));
        vm.roll(block.number + 50); // block height alone no longer opens it
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.RandomnessPending.selector, id));
        d.packs.open(id);

        vrf.fulfillPending();
        assertTrue(d.packs.packReady(id));
        uint256[5] memory fixedIds = contents(id);
        assertGt(fixedIds[0], 0);
        // Whatever Alice does now (buy and open other packs, move cards away) can't change this pack.
        uint256 other = buy(alice, 1);
        vrf.fulfillPending();
        vm.prank(alice);
        d.packs.open(other);
        vm.prank(alice);
        uint256[5] memory got = d.packs.open(id);
        for (uint256 i; i < 5; ++i) {
            assertEq(got[i], fixedIds[i]);
            assertGt(d.cards.balanceOf(alice, got[i]), 0);
        }
        assertFalse(d.packs.packReady(id));
    }

    function test_pityIsDecidedWhenTheWordArrives() public {
        // 19 packs without a Legendary: the 20th must roll one, whichever order Alice opens them in.
        uint256 first = buy(alice, 10);
        uint256 second = buy(alice, 10);
        vrf.fulfillPending();
        bool legendary;
        for (uint256 i; i < 20; ++i) {
            uint256[5] memory ids = contents(i < 10 ? first + i : second + i - 10);
            for (uint256 j; j < 5; ++j) {
                uint256 base = ids[j] >= d.cards.FOIL_OFFSET() ? ids[j] - d.cards.FOIL_OFFSET() : ids[j];
                if (d.cards.cardInfo(base).rarity == 3) legendary = true;
            }
        }
        assertTrue(legendary);
        assertLe(d.packs.packsSinceLegendary(alice), 19);
    }

    function test_onlyTheRequestsCoordinatorAnswers() public {
        uint256 id = buy(alice, 1);
        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.OnlyCoordinator.selector, alice, address(vrf)));
        d.packs.rawFulfillRandomWords(1, words);
        // Unknown requests are ignored rather than reverting.
        vm.prank(alice);
        d.packs.rawFulfillRandomWords(999, words);
        assertEq(d.packs.rolledOf(id), 0);
    }

    function test_aSinglePackRollsWithinTheCallbackGasLimit() public {
        uint256 id = buy(alice, 1);
        vrf.fulfillPending();
        assertGt(d.packs.rolledOf(id), 0);
    }

    function test_aTenPackBundleRollsWithinTheCallbackGasLimit() public {
        vm.recordLogs();
        uint256 first = buy(alice, 10);
        vrf.fulfillPending();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RandomWordsFulfilled(uint256,bool)");
        bool ok;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) ok = abi.decode(logs[i].data, (bool));
        }
        assertTrue(ok, "callback ran out of gas");
        for (uint256 i; i < 10; ++i) {
            assertGt(d.packs.rolledOf(first + i), 0);
        }
    }

    function test_retryNeverReRollsTheFirstAnswerWins() public {
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
        // The coordinator answers the original request first: that answer decides the pack, the retry's is ignored.
        vm.recordLogs();
        vrf.fulfillPending();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 rolledSig = keccak256("PackRolled(uint256,uint256,uint256[5])");
        uint256 rolls;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == rolledSig) rolls++;
        }
        assertEq(rolls, 1);
        assertEq(d.packs.retryableAt(id), 0);
        vm.prank(alice);
        d.packs.open(id);
    }

    function test_switchingVrfOffNeverStrandsAPack() public {
        uint256 id = buy(alice, 1);
        PackSale.VrfConfig memory off;
        vm.prank(admin);
        d.packs.setVrf(off);
        assertTrue(d.packs.packReady(id)); // opening makes progress: it re-seals to a blockhash
        vm.prank(alice);
        uint256[5] memory none = d.packs.open(id);
        assertEq(none[0], 0);
        assertEq(d.packs.vrfRequestOf(id), 0);
        vm.roll(block.number + 3);
        vm.prank(alice);
        uint256[5] memory got = d.packs.open(id);
        assertGt(got[0], 0);
        // A late answer from the old coordinator no longer touches it.
        vrf.fulfillPending();
        assertEq(d.packs.rolledOf(id), 0);
    }

    function test_theOldCoordinatorsAnswerStillCountsAfterSwitching() public {
        uint256 id = buy(alice, 1);
        VRFCoordinatorMock next = new VRFCoordinatorMock();
        PackSale.VrfConfig memory c = config(address(next));
        vm.prank(admin);
        d.packs.setVrf(c);
        vrf.fulfillPending(); // the coordinator the request went to answers
        assertGt(d.packs.rolledOf(id), 0);
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
        uint256 id = buy(alice, 1);
        assertEq(d.packs.vrfRequestOf(id), 0);
        vm.roll(block.number + 3);
        assertTrue(d.packs.packReady(id));
        vm.prank(alice);
        d.packs.open(id);
    }
}
