// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Set1Cards} from "../src/generated/Set1Cards.sol";
import {Fixture} from "./Fixture.sol";
import {CardRegistry} from "../src/CardRegistry.sol";
import {StarterDecks} from "../src/StarterDecks.sol";
import {PackSale} from "../src/PackSale.sol";
import {Crafting} from "../src/Crafting.sol";
import {DeckRegistry} from "../src/DeckRegistry.sol";
import {TestnetOnly} from "../src/TestnetOnly.sol";

contract CardsTest is Fixture {
    function test_set1Defined() public view {
        assertEq(d.cards.allCards().length, Set1Cards.COUNT); // every card the engine defines (core + Poncho collab)
        assertEq(d.cards.cardsOfRarity(3).length, 9); // Set 1 Legendaries so far, plus Poncho
        CardRegistry.CardInfo memory c = d.cards.cardInfo(8); // The Launcher
        assertEq(c.race, 1);
        assertEq(c.rarity, 3);
        CardRegistry.CardInfo memory p = d.cards.cardInfo(48); // Poncho, Cutest Cat on Base
        assertEq(p.race, 0);
        assertEq(p.rarity, 3);
        assertEq(p.chain, 1);
    }

    function test_metadataUrisAreAdminSettable() public {
        assertEq(d.cards.uri(1), "ipfs://cards/{id}.json");
        vm.prank(admin);
        d.cards.setContractURI("https://server/metadata/contract.json");
        assertEq(d.cards.contractURI(), "https://server/metadata/contract.json");
        vm.prank(alice);
        vm.expectRevert();
        d.cards.setContractURI("x");
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

    function test_rankedDeckFitsOneLegendary() public {
        // Agents starter (16 pts) with one Mainframe (7, Rare) swapped for The Launcher (8, Legendary): 18 pts.
        vm.startPrank(alice);
        d.starters.claim(1);
        vm.stopPrank();
        uint256 launcher = 8;
        bytes32 minter = d.cards.MINTER_ROLE();
        vm.prank(admin);
        d.cards.grantRole(minter, address(this));
        d.cards.mint(alice, launcher, 1);
        uint16[] memory ids = starterIds(1);
        bool swapped;
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == 7 && !swapped) {
                // keep the list sorted: drop this 7 and append the 8 after the last 7
                for (uint256 j = i; j + 1 < ids.length && ids[j + 1] <= 8; ++j) {
                    ids[j] = ids[j + 1];
                    ids[j + 1] = 8;
                }
                swapped = true;
            }
        }
        assertTrue(swapped);
        vm.prank(alice);
        bytes32 deckId = d.decks.register(1, ids);
        DeckRegistry.Deck memory deck = d.decks.getDeck(deckId);
        assertEq(deck.rarityPoints, 18);
        assertEq(deck.legendaries, 1);
        assertTrue(d.decks.isValidFor(deckId, alice, true));
    }

    function test_deckRejectsFoilIds() public {
        vm.prank(alice);
        d.starters.claim(1);
        uint16[] memory ids = starterIds(1);
        ids[29] = uint16(d.cards.FOIL_OFFSET() + ids[29]);
        vm.prank(alice);
        vm.expectRevert(bytes("DeckRegistry: use base ids"));
        d.decks.register(1, ids);
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

    function test_expiredBlockhashPackRollsPlainInsteadOfReSealing() public {
        // Waiting out the 256-block window must never be a re-roll: the pack opens at once, with no Legendary
        // upgrade, pity or foil (25 packs would otherwise all but surely bring one, and pity guarantees it).
        vm.deal(alice, 1 ether);
        for (uint256 b; b < 3; ++b) {
            uint256 n = b < 2 ? 10 : 5;
            uint256 cost = d.packs.quoteEth(n);
            vm.prank(alice);
            uint256 first = d.packs.buyWithEth{value: cost}(n);
            vm.roll(block.number + 400);
            for (uint256 i; i < n; ++i) {
                vm.prank(alice);
                uint256[5] memory ids = d.packs.open(first + i);
                for (uint256 j; j < 5; ++j) {
                    assertLt(ids[j], d.cards.FOIL_OFFSET());
                    assertEq(d.cards.balanceOf(alice, ids[j]) > 0, true);
                }
                assertEq(d.cards.cardInfo(ids[4]).rarity, 2);
            }
        }
        assertEq(d.packs.packsSinceLegendary(alice), 25);
    }

    function test_packIdsOfTracksOwners() public {
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(alice);
        d.packs.buyWithEth{value: 0.0002 ether}(2);
        vm.prank(bob);
        d.packs.buyWithEth{value: 0.0001 ether}(1);
        vm.prank(alice);
        d.packs.buyWithEth{value: 0.0001 ether}(1);
        uint256[] memory a = d.packs.packIdsOf(alice);
        assertEq(a.length, 3);
        assertEq(a[0], 0);
        assertEq(a[1], 1);
        assertEq(a[2], 3);
        assertEq(d.packs.packIdsOf(bob)[0], 2);
        assertEq(d.packs.packIdsOf(makeAddr("nobody")).length, 0);
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
        uint256[5] memory ids = d.packs.roll(rand, alice, false);
        for (uint256 i; i < 3; ++i) {
            assertEq(d.cards.cardInfo(ids[i]).rarity, 0);
        }
        assertEq(d.cards.cardInfo(ids[3]).rarity, 1);
        assertGe(d.cards.cardInfo(ids[4]).rarity, 2);
    }

    function test_legendaryRateAboutTenPercent() public view {
        uint256 legendary;
        for (uint256 i; i < 2000; ++i) {
            uint256[5] memory ids = d.packs.roll(keccak256(abi.encode(i)), alice, false);
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

    // ─── Fairness and foils ─────────────────────────────────────
    function openPacks(address who, uint256 n) internal returns (uint256[5][] memory all) {
        vm.deal(who, 1 ether);
        all = new uint256[5][](n);
        uint256 opened;
        while (opened < n) {
            uint256 batch = n - opened > 10 ? 10 : n - opened;
            uint256 cost = d.packs.quoteEth(batch);
            vm.prank(who);
            uint256 first = d.packs.buyWithEth{value: cost}(batch);
            vm.roll(block.number + 3);
            for (uint256 i; i < batch; ++i) {
                vm.prank(who);
                all[opened++] = d.packs.open(first + i);
            }
        }
    }

    function test_pityGuaranteesALegendaryWithin20Packs() public {
        for (uint256 trial; trial < 3; ++trial) {
            address who = makeAddr(string(abi.encode("pity", trial)));
            uint256[5][] memory all = openPacks(who, 20);
            bool any;
            for (uint256 i; i < 20; ++i) {
                if (d.cards.cardInfo(all[i][4]).rarity == 3) any = true;
            }
            assertTrue(any, "a Legendary within 20 packs");
            assertLe(d.packs.packsSinceLegendary(who), 19);
            assertEq(d.packs.packsUntilPity(who), 20 - d.packs.packsSinceLegendary(who));
        }
        // Forced roll always yields a Legendary.
        assertEq(d.cards.cardInfo(d.packs.roll(keccak256("x"), alice, true)[4]).rarity, 3);
    }

    function test_duplicateProtectionFillsTheSetFirst() public {
        // Open enough packs to see every Common; nobody gets a third copy of a Common
        // until they hold two of every Common.
        address who = makeAddr("collector");
        uint256 nCommons = d.cards.cardsOfRarity(0).length;
        openPacks(who, (nCommons * 2) / 3 + 2);
        uint256[] memory commons = d.cards.cardsOfRarity(0);
        uint256 maxHeld;
        uint256 minHeld = type(uint256).max;
        for (uint256 i; i < commons.length; ++i) {
            uint256 h = d.cards.playableBalance(who, commons[i]);
            if (h > maxHeld) maxHeld = h;
            if (h < minHeld) minHeld = h;
        }
        assertTrue(maxHeld <= 2 || minHeld >= 2, "no third copy before the Common set is complete");
        assertGe(minHeld, 1);
    }

    function test_foilsAreCosmeticPlayableAndScrapForMore() public {
        uint256[5][] memory all = openPacks(alice, 40);
        uint256 foils;
        uint256 foilId;
        for (uint256 i; i < 40; ++i) {
            for (uint256 j; j < 5; ++j) {
                if (d.cards.isFoil(all[i][j])) {
                    foils++;
                    foilId = all[i][j];
                }
            }
        }
        assertGt(foils, 2, "about 1 in 15 cards is a foil");
        assertLt(foils, 30);
        uint256 base = d.cards.baseId(foilId);
        assertEq(base, foilId - d.cards.FOIL_OFFSET());
        assertFalse(d.cards.isStarter(foilId));
        assertGe(d.cards.playableBalance(alice, base), 1, "foils count for decks");
        // Foils trade like normal cards.
        vm.prank(alice);
        d.cards.safeTransferFrom(alice, bob, foilId, 1, "");
        assertEq(d.cards.balanceOf(bob, foilId), 1);
        // Scrapping a foil pays 4x; foils can't be crafted.
        uint256 before = d.crafting.scrap(bob);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        (ids[0], amts[0]) = (foilId, 1);
        vm.prank(bob);
        d.crafting.scrapCards(ids, amts);
        assertEq(d.crafting.scrap(bob) - before, d.crafting.scrapValue(d.cards.cardInfo(foilId).rarity) * 4);
        vm.expectRevert(abi.encodeWithSelector(Crafting.FoilNotCraftable.selector, foilId));
        vm.prank(bob);
        d.crafting.craft(foilId);
    }

    function test_bundleDiscounts() public {
        assertEq(d.packs.quoteEth(1), 0.0001 ether);
        assertEq(d.packs.quoteEth(4), 0.0004 ether);
        assertEq(d.packs.quoteEth(5), 0.00045 ether); // 10% off
        assertEq(d.packs.quoteEth(10), 0.00085 ether); // 15% off
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(PackSale.WrongPayment.selector);
        d.packs.buyWithEth{value: 0.0005 ether}(5); // full price is wrong now
        vm.prank(alice);
        d.packs.buyWithEth{value: 0.00045 ether}(5);
        assertEq(d.packs.packIdsOf(alice).length, 5);
        // Tokens too: 10 tUSDC packs for 17 instead of 20.
        vm.prank(bob);
        d.usdc.drip();
        vm.startPrank(bob);
        d.usdc.approve(address(d.packs), 17e6);
        d.packs.buyWithToken(address(d.usdc), 10);
        vm.stopPrank();
        assertEq(d.usdc.balanceOf(bob), 83e6);
    }

    function test_ponchoBoosterOnlyHoldsPonchoCards() public {
        assertEq(d.packs.kindName(1), "Poncho booster");
        vm.expectRevert(abi.encodeWithSelector(PackSale.UnknownKind.selector, uint8(7)));
        d.packs.buyWithEthOf{value: 0.0001 ether}(7, 1);
        vm.deal(alice, 1 ether);
        uint256 cost = d.packs.quoteEth(10);
        vm.prank(alice);
        uint256 first = d.packs.buyWithEthOf{value: cost}(1, 10);
        vm.roll(block.number + 3);
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            uint256[5] memory ids = d.packs.open(first + i);
            for (uint256 j; j < 5; ++j) {
                uint256 base = d.cards.baseId(ids[j]);
                assertTrue(base >= 41 && base <= 48, "Poncho cards only");
            }
            assertEq(d.cards.cardInfo(ids[3]).rarity, 1);
        }
        // Forced pity roll in a Poncho booster gives Poncho himself.
        assertEq(d.cards.baseId(d.packs.roll(keccak256("p"), bob, true, 1)[4]), 48);
    }
}
