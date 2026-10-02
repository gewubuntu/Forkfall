// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Fixture} from "./Fixture.sol";
import {QuestRewards} from "../src/QuestRewards.sol";
import {PackSale} from "../src/PackSale.sol";

contract QuestsTest is Fixture {
    function quests() internal view returns (QuestRewards) {
        return d.quests;
    }

    function test_rewardPaysScrapAndPacksOnce() public {
        bytes32 id = keccak256("alice:20000:win2");
        vm.prank(referee);
        quests().reward(alice, id, 40, 0, 0);
        assertEq(d.crafting.scrap(alice), 40);
        assertTrue(quests().claimed(id));

        vm.prank(referee);
        vm.expectRevert(abi.encodeWithSelector(QuestRewards.AlreadyClaimed.selector, id));
        quests().reward(alice, id, 40, 0, 0);

        // A free Poncho pack: owned, sealed, opens like a bought one.
        uint256 before = d.packs.packCount();
        vm.prank(referee);
        quests().reward(alice, keccak256("alice:week:1"), 0, 1, 1);
        assertEq(d.packs.packCount(), before + 1);
        (address owner,, bool opened, uint8 kind) = d.packs.packs(before);
        assertEq(owner, alice);
        assertFalse(opened);
        assertEq(kind, 1);
        vm.roll(block.number + 3);
        vm.prank(alice);
        uint256[5] memory got = d.packs.open(before);
        assertGt(got[0], 0);
    }

    function test_onlyTheRefereeAndTheGranterContractCanPay() public {
        vm.prank(alice);
        vm.expectRevert();
        quests().reward(alice, keccak256("x"), 10, 0, 0);
        bytes32 role = d.crafting.SCRAP_GRANTER_ROLE(); // read before the prank, which the next call consumes
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        d.crafting.grantScrap(alice, 1000);
        vm.prank(referee);
        vm.expectRevert();
        d.packs.grantPacks(referee, 0, 1); // the referee pays through QuestRewards only
    }

    function test_capsAndDailyBudget() public {
        vm.startPrank(referee);
        vm.expectRevert(QuestRewards.OverClaimCap.selector);
        quests().reward(alice, keccak256("big"), 501, 0, 0);
        vm.expectRevert(QuestRewards.OverClaimCap.selector);
        quests().reward(alice, keccak256("packs"), 0, 0, 3);
        vm.expectRevert(QuestRewards.NothingToPay.selector);
        quests().reward(alice, keccak256("zero"), 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(PackSale.UnknownKind.selector, 9));
        quests().reward(alice, keccak256("kind"), 0, 9, 1);
        vm.stopPrank();

        vm.prank(admin);
        quests().setCaps(500, 2, 900, 10);
        vm.startPrank(referee);
        quests().reward(alice, keccak256("a"), 500, 0, 0);
        vm.expectRevert(QuestRewards.OverDailyBudget.selector);
        quests().reward(bob, keccak256("b"), 401, 0, 0);
        // The budget resets the next UTC day.
        vm.warp(block.timestamp + 1 days);
        quests().reward(bob, keccak256("b"), 401, 0, 0);
        vm.stopPrank();
        assertEq(d.crafting.scrap(bob), 401);
    }

    function test_grantedScrapCrafts() public {
        vm.prank(referee);
        quests().reward(alice, keccak256("craft"), 40, 0, 0);
        vm.prank(alice);
        d.crafting.craft(2); // a Common costs 40
        assertEq(d.cards.balanceOf(alice, 2), 1);
        assertEq(d.crafting.scrap(alice), 0);
    }
}
