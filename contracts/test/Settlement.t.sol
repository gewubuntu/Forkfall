// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {MatchSettlement} from "../src/MatchSettlement.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SeasonRewards} from "../src/SeasonRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SettlementTest is Fixture {
    bytes32 deckA;
    bytes32 deckB;

    function setUp() public override {
        super.setUp();
        deckA = claimAndRegister(alice, 1);
        deckB = claimAndRegister(bob, 4);
    }

    function result(uint8 mode, address winner) internal view returns (MatchSettlement.MatchResult memory r) {
        r = MatchSettlement.MatchResult({
            matchId: keccak256(abi.encode("m", mode, winner)),
            playerA: alice,
            playerB: bob,
            winner: winner,
            deckA: deckA,
            deckB: deckB,
            mode: mode,
            season: 1,
            turns: 16,
            logHash: keccak256("log")
        });
    }

    function refSig(MatchSettlement.MatchResult memory r) internal view returns (bytes memory) {
        return sign(refereePk, r);
    }

    function sign(uint256 pk, MatchSettlement.MatchResult memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, d.settlement.hashResult(r));
        return abi.encodePacked(rr, s, v);
    }

    function test_rankedSettleUpdatesElo() public {
        MatchSettlement.MatchResult memory r = result(1, alice);
        bytes memory rs = refSig(r);
        d.settlement.settle(r, sign(alicePk, r), sign(bobPk, r), rs);
        MatchSettlement.Stats memory a = d.settlement.stats(1, alice);
        MatchSettlement.Stats memory b = d.settlement.stats(1, bob);
        assertEq(a.wins, 1);
        assertEq(b.losses, 1);
        assertEq(a.rating, 1216);
        assertEq(b.rating, 1184);
        assertTrue(d.settlement.settled(r.matchId));

        bytes memory sa = sign(alicePk, r);
        bytes memory sb = sign(bobPk, r);
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.AlreadySettled.selector, r.matchId));
        d.settlement.settle(r, sa, sb, rs);
    }

    function test_forgedSignatureRejected() public {
        MatchSettlement.MatchResult memory r = result(1, alice);
        bytes memory rs;
        bytes memory sa = sign(alicePk, r);
        bytes memory bad = sign(alicePk, r); // alice signs for bob
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.BadSignature.selector, bob));
        d.settlement.settle(r, sa, bad, rs);
    }

    function test_tamperedResultRejected() public {
        MatchSettlement.MatchResult memory r = result(1, alice);
        bytes memory rs;
        bytes memory sa = sign(alicePk, r);
        bytes memory sb = sign(bobPk, r);
        r.winner = bob;
        vm.expectRevert();
        d.settlement.settle(r, sa, sb, rs);
    }

    function test_refereePathNeedsRoleAndWinnerSig() public {
        MatchSettlement.MatchResult memory r = result(1, bob);
        bytes memory sb = sign(bobPk, r);
        vm.expectRevert();
        d.settlement.settleByReferee(r, sb);
        vm.prank(referee);
        d.settlement.settleByReferee(r, sb);
        assertEq(d.settlement.stats(1, bob).wins, 1);
    }

    function test_rankedRequiresValidDeck() public {
        MatchSettlement.MatchResult memory r = result(1, alice);
        bytes memory rs;
        r.deckB = deckA;
        bytes memory sa = sign(alicePk, r);
        bytes memory sb = sign(bobPk, r);
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.InvalidDeck.selector, bob));
        d.settlement.settle(r, sa, sb, rs);
    }

    function test_bannedPlayerCannotSettleRanked() public {
        vm.prank(admin);
        d.agents.setBan(bob, true, "collusion");
        MatchSettlement.MatchResult memory r = result(1, alice);
        bytes memory rs;
        bytes memory sa = sign(alicePk, r);
        bytes memory sb = sign(bobPk, r);
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.Banned.selector, bob));
        d.settlement.settle(r, sa, sb, rs);
    }

    function test_humanQueueIsOpenToEveryoneButAgents() public {
        MatchSettlement.MatchResult memory r = result(2, alice);
        bytes memory rs = refSig(r);
        bytes memory sa = sign(alicePk, r);
        bytes memory sb = sign(bobPk, r);

        // bob's wallet becomes an agent (self-owned ERC-8004 agent): the Human queue rejects it.
        vm.prank(bob);
        uint256 agentId = d.agents.register("ipfs://bob-bot");
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.NotHuman.selector, bob));
        d.settlement.settle(r, sa, sb, rs);

        // Deregistered: no verification needed to play the Human queue.
        vm.prank(bob);
        d.agents.burn(agentId);
        d.settlement.settle(r, sa, sb, rs);
        assertEq(d.settlement.stats(1, alice).wins, 1);
    }

    function test_rankedNeedsRefereeCoSignature() public {
        MatchSettlement.MatchResult memory r = result(1, alice);
        bytes memory sa = sign(alicePk, r);
        bytes memory sb = sign(bobPk, r);
        bytes memory fakeRef = sign(alicePk, r); // colluding player posing as referee
        vm.expectRevert(MatchSettlement.MissingRefereeSignature.selector);
        d.settlement.settle(r, sa, sb, "");
        vm.expectRevert(MatchSettlement.MissingRefereeSignature.selector);
        d.settlement.settle(r, sa, sb, fakeRef);
        d.settlement.settle(r, sa, sb, refSig(r));
    }

    function test_casualResultCannotHoldARankedMatchId() public {
        MatchSettlement.MatchResult memory ranked = result(1, alice);
        // bob, about to lose, settles a casual "match" under the same id with two wallets he controls.
        uint256 xPk = 0xB0B1;
        uint256 yPk = 0xB0B2;
        MatchSettlement.MatchResult memory squat = result(0, address(0));
        squat.matchId = ranked.matchId;
        squat.playerA = vm.addr(xPk);
        squat.playerB = vm.addr(yPk);
        d.settlement.settle(squat, sign(xPk, squat), sign(yPk, squat), "");
        assertTrue(d.settlement.settled(ranked.matchId));
        assertFalse(d.settlement.settledFinal(ranked.matchId));

        (bytes memory sa, bytes memory sb, bytes memory sr) =
            (sign(alicePk, ranked), sign(bobPk, ranked), refSig(ranked));
        d.settlement.settle(ranked, sa, sb, sr);
        assertTrue(d.settlement.settledFinal(ranked.matchId));
        assertEq(d.settlement.stats(1, alice).wins, 1);
        assertEq(d.settlement.stats(1, bob).losses, 1);

        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.AlreadySettled.selector, ranked.matchId));
        d.settlement.settle(ranked, sa, sb, sr);
        (bytes memory sx, bytes memory sy) = (sign(xPk, squat), sign(yPk, squat));
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.AlreadySettled.selector, ranked.matchId));
        d.settlement.settle(squat, sx, sy, "");
    }

    function test_casualSkipsDeckChecksAndElo() public {
        MatchSettlement.MatchResult memory r = result(0, address(0));
        bytes memory rs;
        r.deckA = bytes32(0);
        r.deckB = bytes32(0);
        d.settlement.settle(r, sign(alicePk, r), sign(bobPk, r), rs);
        assertEq(d.settlement.stats(0, alice).draws, 1);
        assertEq(d.settlement.stats(1, alice).rating, 1200);
    }

    function test_expectedScoreSymmetric() public view {
        assertEq(d.settlement.expectedScore(1200, 1200), 500);
        assertEq(d.settlement.expectedScore(1600, 1200), 909);
        assertEq(d.settlement.expectedScore(1200, 1600), 91);
        assertEq(d.settlement.expectedScore(3000, 100), 990);
    }

    function testFuzz_eloConserved(uint16 ra, uint16 rb) public view {
        uint256 a = bound(ra, 100, 3000);
        uint256 b = bound(rb, 100, 3000);
        assertEq(d.settlement.expectedScore(a, b) + d.settlement.expectedScore(b, a), 1000);
    }

    function test_seasonRewardsMerkleClaim() public {
        // Two-leaf tree: alice 500, bob 250.
        bytes32 la = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(500 ether)))));
        bytes32 lb = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(250 ether)))));
        bytes32 root = la < lb ? keccak256(abi.encode(la, lb)) : keccak256(abi.encode(lb, la));
        vm.startPrank(admin);
        d.fall.mint(address(d.rewards), 750 ether);
        d.rewards.publishSeason(1, root, IERC20(address(d.fall)), 0);
        vm.stopPrank();

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = lb;
        vm.prank(alice);
        d.rewards.claim(1, 500 ether, proof);
        assertEq(d.fall.balanceOf(alice), 500 ether);

        vm.prank(alice);
        vm.expectRevert(SeasonRewards.AlreadyClaimed.selector);
        d.rewards.claim(1, 500 ether, proof);

        vm.prank(bob);
        vm.expectRevert(SeasonRewards.BadProof.selector);
        d.rewards.claim(1, 999 ether, proof);
    }
}
