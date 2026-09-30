// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {StarterDecks} from "../src/StarterDecks.sol";
import {PackSale} from "../src/PackSale.sol";
import {Crafting} from "../src/Crafting.sol";
import {DeckRegistry} from "../src/DeckRegistry.sol";
import {TestnetOnly} from "../src/TestnetOnly.sol";

contract CardsTest is Fixture {
    function test_set1Defined() public view {
        assertEq(d.cards.allCards().length, 40);
        assertEq(d.cards.cardsOfRarity(3).length, 4); // one legendary per race
        CardRegistry.CardInfo memory c = d.cards.cardInfo(8); // The Launcher
        assertEq(c.race, 1);
        assertEq(c.rarity, 3);
    }

    function test_starterClaimIsSoulbound() public {
        vm.prank(alice);
        d.starters.claim(1);
        uint256 starterId = 1 + d.cards.STARTER_OFFSET();
        assertEq(d.cards.balanceOf(alice, starterId), 2);
        assertEq(d.cards.playableBalance(alice, 1), 2);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardRegistry.Soulbound.selector, starterId));
        d.cards.safeTransferFrom(alice, bob, starterId, 1, "");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StarterDecks.AlreadyClaimed.selector, alice, uint8(1)));
        d.starters.claim(1);
    }

    function test_registerStarterDeckIsRankedLegal() public {
        bytes32 deckId = claimAndRegister(alice, 2);
        assertTrue(d.decks.isValidFor(deckId, alice, true));
        assertFalse(d.decks.isValidFor(deckId, bob, true));
    }

    function test_deckRejectsUnownedAndOffRace() public {
        uint16[] memory starter = starterIds(1);
        vm.prank(alice);
        vm.expectRevert(); // owns nothing
        d.decks.register(1, starter);

        vm.prank(alice);
        d.starters.claim(1);
        uint16[] memory ids = starterIds(1);
        ids[0] = 17; // brokers card breaks sort + race
        vm.prank(alice);
        vm.expectRevert();
        d.decks.register(1, ids);
    }

    function test_buyAndOpenPack() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 first = d.packs.buyWithEth{value: 0.0002 ether}(2);
        assertEq(first, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.TooEarly.selector, block.number + 2));
        d.packs.open(0);

        vm.roll(block.number + 3);
        vm.prank(alice);
        uint256[5] memory ids = d.packs.open(0);
        for (uint256 i; i < 3; ++i) {
            assertEq(d.cards.cardInfo(ids[i]).rarity, 0);
        }
        assertEq(d.cards.cardInfo(ids[3]).rarity, 1);
        assertGe(d.cards.cardInfo(ids[4]).rarity, 2);
        uint256 total;
        for (uint256 i; i < 5; ++i) {
            total += d.cards.balanceOf(alice, ids[i]);
        }
        assertGe(total, 5);

        vm.prank(alice);
        vm.expectRevert(PackSale.AlreadyOpened.selector);
        d.packs.open(0);
        vm.prank(bob);
        vm.expectRevert(PackSale.NotOwner.selector);
        d.packs.open(1);
    }

    function test_packRecommitsWhenBlockhashExpires() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        d.packs.buyWithEth{value: 0.0001 ether}(1);
        vm.roll(block.number + 400);
        vm.prank(alice);
        uint256[5] memory ids = d.packs.open(0);
        assertEq(ids[0], 0); // re-committed, nothing minted
        vm.roll(block.number + 3);
        vm.prank(alice);
        ids = d.packs.open(0);
        assertGt(ids[0], 0);
    }

    function test_buyWithTestUsdc() public {
        vm.prank(alice);
        d.usdc.drip();
        vm.startPrank(alice);
        d.usdc.approve(address(d.packs), 4e6);
        d.packs.buyWithToken(address(d.usdc), 2);
        vm.stopPrank();
        assertEq(d.usdc.balanceOf(alice), 96e6);
        assertEq(d.packs.packCount(), 2);
    }

    function test_wrongPaymentReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(PackSale.WrongPayment.selector);
        d.packs.buyWithEth{value: 1}(1);
    }

    function testFuzz_rollAlwaysValidRarities(bytes32 rand) public view {
        uint256[5] memory ids = d.packs.roll(rand);
        for (uint256 i; i < 3; ++i) {
            assertEq(d.cards.cardInfo(ids[i]).rarity, 0);
        }
        assertEq(d.cards.cardInfo(ids[3]).rarity, 1);
        assertGe(d.cards.cardInfo(ids[4]).rarity, 2);
    }

    function test_legendaryRateAboutTenPercent() public view {
        uint256 legendary;
        for (uint256 i; i < 2000; ++i) {
            uint256[5] memory ids = d.packs.roll(keccak256(abi.encode(i)));
            if (d.cards.cardInfo(ids[4]).rarity == 3) legendary++;
        }
        assertGt(legendary, 140);
        assertLt(legendary, 260);
    }

    function test_craftingScrapLoop() public {
        vm.prank(address(d.packs));
        d.cards.mint(alice, 1, 8); // 8 commons -> 40 scrap
        vm.startPrank(alice);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = 1;
        amounts[0] = 8;
        d.crafting.scrapCards(ids, amounts);
        assertEq(d.crafting.scrap(alice), 40);
        d.crafting.craft(2);
        vm.stopPrank();
        assertEq(d.cards.balanceOf(alice, 2), 1);
        assertEq(d.crafting.scrap(alice), 0);
    }

    function test_starterCannotBeScrapped() public {
        vm.prank(alice);
        d.starters.claim(1);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = 1 + d.cards.STARTER_OFFSET();
        amounts[0] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Crafting.StarterNotScrappable.selector, ids[0]));
        d.crafting.scrapCards(ids, amounts);
    }

    function test_refusesMainnet() public {
        vm.chainId(8453); // Base mainnet
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.MainnetNotAllowed.selector, 8453));
        new CardRegistry(admin, "");
        vm.chainId(4663); // Robinhood Chain mainnet
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.MainnetNotAllowed.selector, 4663));
        new DeckRegistry(d.cards);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.MainnetNotAllowed.selector, 1));
        new CardRegistry(admin, "");
    }

    function test_testnetsAllowed() public {
        vm.chainId(84532);
        new CardRegistry(admin, "");
        vm.chainId(46630);
        new CardRegistry(admin, "");
    }
}
