// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {PackGifts} from "../src/PackGifts.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract PackGiftsTest is Fixture {
    address treasury;
    bytes32 constant GIFT = keccak256("challenge gift 1");

    function setUp() public override {
        super.setUp();
        treasury = d.packs.treasury();
        vm.deal(alice, 1 ether);
        vm.prank(admin);
        d.usdc.mint(alice, 100e6);
        vm.prank(alice);
        d.usdc.approve(address(d.gifts), type(uint256).max);
    }

    function test_giftsPacksToAFriendAtPackSalePrices() public {
        uint256 price = d.packs.quoteEth(5); // the 5-pack bundle discount applies to gifts too
        assertEq(d.gifts.quoteEth(5), price);
        vm.prank(alice);
        uint256 first = d.gifts.giftWithEth{value: price}(bob, 0, 5);
        uint256[] memory bobs = d.packs.packIdsOf(bob);
        assertEq(bobs.length, 5);
        assertEq(bobs[0], first);
        assertEq(d.packs.packIdsOf(alice).length, 0);
        assertEq(treasury.balance, price);

        uint256 usdc = d.packs.quoteToken(address(d.usdc), 1);
        vm.prank(alice);
        d.gifts.giftWithToken(address(d.usdc), bob, 0, 1);
        assertEq(d.packs.packIdsOf(bob).length, 6);
        assertEq(d.usdc.balanceOf(treasury), usdc);
    }

    function test_refusesWrongPaymentsKindsCountsAndNobody() public {
        uint256 one = d.packs.quoteEth(1);
        vm.startPrank(alice);
        vm.expectRevert(PackGifts.WrongPayment.selector);
        d.gifts.giftWithEth{value: one - 1}(bob, 0, 1);
        vm.expectRevert(PackGifts.BadCount.selector);
        d.gifts.giftWithEth{value: 0}(bob, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(PackGifts.UnknownKind.selector, uint8(9)));
        d.gifts.giftWithEth{value: one}(bob, 9, 1);
        vm.expectRevert(PackGifts.ZeroAddress.selector);
        d.gifts.giftWithEth{value: one}(address(0), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(PackGifts.TokenNotAccepted.selector, address(0xdead)));
        d.gifts.giftWithToken(address(0xdead), bob, 0, 1);
        vm.stopPrank();
    }

    function test_holdsAChallengeGiftUntilTheRefereeDeliversIt() public {
        uint256 price = d.packs.quoteEth(2);
        vm.prank(alice);
        d.gifts.holdWithEth{value: price}(GIFT, 0, 2);
        assertEq(address(d.gifts).balance, price); // held, not yet the treasury's
        assertEq(treasury.balance, 0);

        bytes32 role = d.gifts.DELIVERER_ROLE();
        vm.prank(alice); // only the referee delivers
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        d.gifts.deliver(GIFT, alice);

        vm.prank(referee);
        d.gifts.deliver(GIFT, bob);
        assertEq(d.packs.packIdsOf(bob).length, 2);
        assertEq(treasury.balance, price);
        assertEq(address(d.gifts).balance, 0);

        vm.prank(referee); // delivered once, and the id is never reused
        vm.expectRevert(abi.encodeWithSelector(PackGifts.NotHeld.selector, GIFT));
        d.gifts.deliver(GIFT, bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackGifts.GiftIdTaken.selector, GIFT));
        d.gifts.holdWithEth{value: price}(GIFT, 0, 2);
        vm.warp(block.timestamp + 4 days);
        vm.expectRevert(abi.encodeWithSelector(PackGifts.NotHeld.selector, GIFT));
        d.gifts.refund(GIFT);
    }

    function test_refundsAGiftNobodyPlayedForAfterTheHoldTime() public {
        uint256 price = d.packs.quoteToken(address(d.usdc), 1);
        vm.prank(alice);
        d.gifts.holdWithToken(address(d.usdc), GIFT, 0, 1);
        assertEq(d.usdc.balanceOf(address(d.gifts)), price);
        (,,,, uint40 refundableAt,,) = d.gifts.gifts(GIFT);

        vm.expectRevert(abi.encodeWithSelector(PackGifts.TooEarly.selector, uint256(refundableAt)));
        d.gifts.refund(GIFT);
        vm.warp(refundableAt);
        d.gifts.refund(GIFT); // anyone may trigger it; the money goes back to the buyer
        assertEq(d.usdc.balanceOf(alice), 100e6);
        assertEq(d.usdc.balanceOf(address(d.gifts)), 0);

        vm.prank(referee); // too late to deliver a refunded gift
        vm.expectRevert(abi.encodeWithSelector(PackGifts.NotHeld.selector, GIFT));
        d.gifts.deliver(GIFT, bob);
    }

    function test_ethRefundGoesBackToTheBuyer() public {
        uint256 price = d.packs.quoteEth(1);
        vm.prank(alice);
        d.gifts.holdWithEth{value: price}(GIFT, 0, 1);
        vm.warp(block.timestamp + d.gifts.HOLD_TIME());
        uint256 before = alice.balance;
        vm.prank(bob);
        d.gifts.refund(GIFT);
        assertEq(alice.balance, before + price);
    }
}
