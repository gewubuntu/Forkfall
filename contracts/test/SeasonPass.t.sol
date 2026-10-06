// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {SeasonPass} from "../src/SeasonPass.sol";

contract SeasonPassTest is Fixture {
    address treasury = makeAddr("passTreasury");

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        d.pass.setTreasury(payable(treasury));
        vm.warp(d.pass.epoch() + 3 days); // season 1
    }

    function test_seasonsAreFourWeeksFromTheEpoch() public {
        assertEq(d.pass.currentSeason(), 1);
        vm.warp(d.pass.epoch() + 28 days - 1);
        assertEq(d.pass.currentSeason(), 1);
        vm.warp(d.pass.epoch() + 28 days);
        assertEq(d.pass.currentSeason(), 2);
        vm.warp(d.pass.epoch() - 1);
        assertEq(d.pass.currentSeason(), 1);
    }

    function test_buyWithEthForTheRunningSeasonOnly() public {
        uint256 price = d.pass.ethPrice();
        assertEq(price, 0.0004 ether);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        d.pass.buyWithEth{value: price}(alice);
        assertTrue(d.pass.hasPass(1, alice));
        assertFalse(d.pass.hasPass(2, alice));
        assertEq(treasury.balance, price);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SeasonPass.AlreadyHasPass.selector, uint32(1), alice));
        d.pass.buyWithEth{value: price}(alice);

        vm.prank(alice);
        vm.expectRevert(SeasonPass.WrongPayment.selector);
        d.pass.buyWithEth{value: price - 1}(bob);

        vm.warp(d.pass.epoch() + 28 days); // next season: a new pass
        vm.prank(alice);
        d.pass.buyWithEth{value: price}(alice);
        assertTrue(d.pass.hasPass(2, alice));
    }

    function test_giftWithTestUsdc() public {
        vm.prank(admin);
        d.usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        d.usdc.approve(address(d.pass), 8e6);
        d.pass.buyWithToken(address(d.usdc), bob);
        vm.stopPrank();
        assertTrue(d.pass.hasPass(1, bob));
        assertFalse(d.pass.hasPass(1, alice));
        assertEq(d.usdc.balanceOf(treasury), 8e6);
        assertEq(d.usdc.balanceOf(alice), 2e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SeasonPass.TokenNotAccepted.selector, address(d.fall)));
        d.pass.buyWithToken(address(d.fall), alice);
    }

    function test_onlyAdminsSetPricesAndTreasury() public {
        vm.prank(alice);
        vm.expectRevert();
        d.pass.setEthPrice(1);
        vm.prank(alice);
        vm.expectRevert();
        d.pass.setTreasury(payable(alice));
        vm.prank(admin);
        d.pass.setEthPrice(0); // sale paused in ETH
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(SeasonPass.WrongPayment.selector);
        d.pass.buyWithEth{value: 0}(alice);
    }
}
