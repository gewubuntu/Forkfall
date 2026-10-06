// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {AgentLeague} from "../src/AgentLeague.sol";
import {MatchSettlement} from "../src/MatchSettlement.sol";

/// @notice A wallet that accepts signatures only once `target` is settled in the league.
contract SettledOnlyWallet {
    AgentLeague immutable league;
    bytes32 immutable target;

    constructor(AgentLeague l, bytes32 t) {
        league = l;
        target = t;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        (,,, AgentLeague.State state,) = league.matches(target);
        return state == AgentLeague.State.Settled ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract AnySigWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

contract LeagueTest is Fixture {
    AgentLeague league;
    bytes32 deckA;
    bytes32 deckB;
    uint256 carlPk = 0xCA41;
    address carl;
    uint256 n;

    function setUp() public override {
        super.setUp();
        league = d.league;
        carl = vm.addr(carlPk);
        deckA = claimAndRegister(alice, 1);
        deckB = claimAndRegister(bob, 4);
        // alice and bob are self-owned agents (their own operators)
        vm.prank(alice);
        d.agents.register("ipfs://alice-bot");
        vm.prank(bob);
        d.agents.register("ipfs://bob-bot");
        for (uint256 i; i < 3; i++) {
            address who = i == 0 ? alice : i == 1 ? bob : carl;
            vm.prank(admin);
            d.usdc.mint(who, 100e6);
            vm.startPrank(who);
            d.usdc.approve(address(league), type(uint256).max);
            if (who != carl) league.deposit(10e6);
            vm.stopPrank();
        }
    }

    function start() internal returns (bytes32 id) {
        id = keccak256(abi.encode("league", ++n));
        vm.prank(referee);
        league.startMatch(id, alice, bob);
    }

    function sign(uint256 pk, MatchSettlement.MatchResult memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, d.settlement.hashResult(r));
        return abi.encodePacked(rr, s, v);
    }

    function settle(bytes32 id, address winner) internal {
        settleExpect(id, winner, "");
    }

    /// @dev Signs first, so an expected revert applies to settle() itself, not to the hashResult view call.
    function settleExpect(bytes32 id, address winner, bytes memory err) internal {
        MatchSettlement.MatchResult memory r = MatchSettlement.MatchResult({
            matchId: id,
            playerA: alice,
            playerB: bob,
            winner: winner,
            deckA: deckA,
            deckB: deckB,
            mode: 3,
            season: league.currentWeek(),
            turns: 14,
            logHash: keccak256("log")
        });
        (bytes memory sa, bytes memory sb, bytes memory sr) = (sign(alicePk, r), sign(bobPk, r), sign(refereePk, r));
        if (err.length > 0) vm.expectRevert(err);
        d.settlement.settle(r, sa, sb, sr);
    }

    function test_startChargesBothAndTheResultSplitsTheFee() public {
        bytes32 id = start();
        assertEq(league.balanceOf(alice), 9.5e6);
        assertEq(league.balanceOf(bob), 9.5e6);
        assertEq(league.pot(1), 0);
        assertEq(league.buybackAccrued() + league.opsAccrued(), 0);
        settle(id, alice);
        assertEq(league.pot(1), 0.8e6); // 80% of 1.00
        assertEq(league.buybackAccrued(), 0.1e6);
        assertEq(league.opsAccrued(), 0.1e6);
        league.sweep();
        assertEq(d.usdc.balanceOf(admin), 0.2e6); // buyback sink and ops treasury are the admin on testnet
    }

    function test_pairingRules() public {
        bytes32 id = keccak256("x");
        vm.prank(alice);
        vm.expectRevert();
        league.startMatch(id, alice, bob); // only the referee

        // carl is alice's agent: same operator → never paired
        uint256 next = d.agents.nextAgentId();
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(carlPk, d.agents.agentWalletDigest(next, carl, alice, dl));
        vm.prank(alice);
        d.agents.registerWithWallet("ipfs://carl", next, carl, dl, abi.encodePacked(r, s, v));
        vm.prank(carl);
        league.deposit(5e6);
        (bool ok, string memory why) = league.canPair(alice, carl);
        assertFalse(ok);
        assertEq(why, "same operator");
        vm.prank(referee);
        vm.expectRevert(abi.encodeWithSelector(AgentLeague.SameOperator.selector, alice));
        league.startMatch(id, alice, carl);

        // not an agent / not funded
        vm.prank(referee);
        vm.expectRevert(abi.encodeWithSelector(AgentLeague.NotAgent.selector, address(0xBEEF)));
        league.startMatch(id, alice, address(0xBEEF));
        vm.prank(bob);
        league.withdraw(bob, 9.8e6);
        vm.prank(referee);
        vm.expectRevert(abi.encodeWithSelector(AgentLeague.InsufficientBalance.selector, bob, 0.2e6, 0.5e6));
        league.startMatch(id, alice, bob);
    }

    function test_settledLeagueResultBuildsStandingsNotRankedStats() public {
        bytes32 id = start();
        settle(id, alice);
        AgentLeague.Standing memory a = league.standing(1, alice);
        AgentLeague.Standing memory b = league.standing(1, bob);
        assertEq(a.wins, 1);
        assertEq(b.losses, 1);
        assertEq(a.rating, 1216);
        assertEq(b.rating, 1184);
        assertEq(a.opponents, 1);
        assertEq(d.settlement.stats(1, alice).wins, 0, "ranked ladder untouched");
        assertEq(league.players(1).length, 2);

        // An unstarted match id cannot be settled as a league result.
        bytes32 fake = keccak256("fake");
        settleExpect(fake, alice, abi.encodeWithSelector(AgentLeague.BadMatchState.selector, fake));
    }

    function test_onlyFirstThreeMeetingsPerWeekAreRated() public {
        for (uint256 i; i < 3; i++) {
            settle(start(), alice);
        }
        uint32 after3 = league.standing(1, alice).rating;
        settle(start(), alice);
        AgentLeague.Standing memory a = league.standing(1, alice);
        assertEq(a.games, 4);
        assertEq(a.wins, 4);
        assertEq(a.rating, after3, "4th meeting counts as a game but not for rating");
        assertEq(a.opponents, 1);
    }

    function test_cancelRefundsEverything() public {
        bytes32 id = start();
        vm.prank(referee);
        league.cancelMatch(id);
        assertEq(league.balanceOf(alice), 10e6);
        assertEq(league.balanceOf(bob), 10e6);
        assertEq(league.pot(1), 0);
        assertEq(league.buybackAccrued() + league.opsAccrued(), 0);
        settleExpect(id, alice, abi.encodeWithSelector(AgentLeague.BadMatchState.selector, id));
    }

    function test_sweepCannotBlockACancelRefund() public {
        settle(start(), alice);
        bytes32 id = start();
        league.sweep();
        vm.prank(referee);
        league.cancelMatch(id);
        assertEq(league.balanceOf(alice), 9.5e6);
        assertEq(league.balanceOf(bob), 9.5e6);
        assertEq(league.pot(1), 0.8e6);
    }

    function test_resultsCloseOnceTheWeekIsPublished() public {
        bytes32 id = start();
        vm.warp(block.timestamp + 7 days);
        vm.prank(admin);
        league.publishWeek(1, keccak256("root"), uint64(block.timestamp + 7 days));
        settleExpect(id, alice, abi.encodeWithSelector(AgentLeague.ResultsClosed.selector, uint32(1)));
        vm.prank(referee);
        league.cancelMatch(id);
        assertEq(league.balanceOf(alice), 10e6);
    }

    function test_erc6492FactoryCallCannotActAsTheSettlement() public {
        bytes32 id = start();
        // A throwaway casual result whose "factory call" tries to record the league match from MatchSettlement.
        SettledOnlyWallet wa = new SettledOnlyWallet(league, id);
        AnySigWallet wb = new AnySigWallet();
        MatchSettlement.MatchResult memory r = MatchSettlement.MatchResult({
            matchId: keccak256("throwaway"),
            playerA: address(wa),
            playerB: address(wb),
            winner: address(0),
            deckA: bytes32(0),
            deckB: bytes32(0),
            mode: 0,
            season: 0,
            turns: 1,
            logHash: bytes32(0)
        });
        bytes memory sigA = abi.encodePacked(
            abi.encode(address(league), abi.encodeCall(AgentLeague.recordResult, (id, bob)), bytes("")),
            bytes32(0x6492649264926492649264926492649264926492649264926492649264926492)
        );
        vm.prank(carl);
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.BadSignature.selector, address(wa)));
        d.settlement.settle(r, sigA, hex"00", "");
        (,,, AgentLeague.State state,) = league.matches(id);
        assertEq(uint8(state), uint8(AgentLeague.State.Started));
        settle(id, alice);
        assertEq(league.standing(1, alice).wins, 1);
    }

    function test_weeklyPayoutGoesToOperatorsAndNeverExceedsThePot() public {
        settle(start(), alice);
        settle(start(), bob);
        vm.prank(carl);
        league.fundPot(1, 2e6); // sponsor top-up
        uint256 potW1 = league.pot(1); // 2 x 0.8 + 2 = 3.6
        assertEq(potW1, 3.6e6);

        bytes32 la = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(2.4e6)))));
        bytes32 lb = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(1.2e6)))));
        bytes32 root = la < lb ? keccak256(abi.encode(la, lb)) : keccak256(abi.encode(lb, la));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentLeague.WeekNotOver.selector, uint32(1)));
        league.publishWeek(1, root, 0);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(admin);
        league.publishWeek(1, root, uint64(block.timestamp + 30 days));

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = lb;
        uint256 before = d.usdc.balanceOf(alice);
        league.claim(1, alice, 2.4e6, proof); // anyone can trigger; funds go to alice's operator (alice)
        assertEq(d.usdc.balanceOf(alice) - before, 2.4e6);
        vm.expectRevert(AgentLeague.AlreadyClaimed.selector);
        league.claim(1, alice, 2.4e6, proof);
        proof[0] = la;
        vm.expectRevert(AgentLeague.BadProof.selector);
        league.claim(1, bob, 9e6, proof);

        // Unclaimed prizes roll into the current week after the claim window.
        vm.warp(block.timestamp + 31 days);
        vm.prank(admin);
        league.rollover(1);
        assertEq(league.pot(1), 2.4e6);
        assertEq(league.pot(league.currentWeek()), 1.2e6);
    }

    function test_overspendingRootIsCapped() public {
        settle(start(), alice); // pot 0.8
        bytes32 la = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(5e6)))));
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(admin);
        league.publishWeek(1, la, 0);
        vm.expectRevert(abi.encodeWithSelector(AgentLeague.ExceedsPot.selector, uint32(1)));
        league.claim(1, alice, 5e6, new bytes32[](0));
    }

    function test_withdrawByAgentOrOperatorOnly() public {
        vm.prank(carl);
        vm.expectRevert(AgentLeague.NotAgentOrOperator.selector);
        league.withdraw(alice, 1e6);
        vm.prank(alice);
        league.withdraw(alice, 4e6);
        assertEq(league.balanceOf(alice), 6e6);
        vm.prank(carl);
        league.depositFor(bob, 1e6);
        assertEq(league.balanceOf(bob), 11e6);
    }

    function test_badSplitRejected() public {
        vm.prank(admin);
        vm.expectRevert(AgentLeague.BadSplit.selector);
        league.setParams(1e6, 9_000, 2_000, admin, admin);
    }
}
