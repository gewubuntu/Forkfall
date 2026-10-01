// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {MockSmartWallet, MockWalletFactory} from "./mocks/MockSmartWallet.sol";
import {MatchSettlement} from "../src/MatchSettlement.sol";

/// @notice A factory that tries to settle the same match again from inside the 6492 factory call.
contract ReentrantFactory {
    MatchSettlement immutable settlement;
    MockWalletFactory immutable real;
    MatchSettlement.MatchResult r;
    bytes sigA;
    bytes sigB;
    bool public reentered;

    constructor(MatchSettlement s, MockWalletFactory f) {
        settlement = s;
        real = f;
    }

    function arm(MatchSettlement.MatchResult memory r_, bytes memory a, bytes memory b) external {
        r = r_;
        sigA = a;
        sigB = b;
    }

    function createAccount(address owner, bytes32 salt) external returns (address) {
        try settlement.settle(r, sigA, sigB, "") {
            reentered = true;
        } catch {}
        return real.createAccount(owner, salt);
    }
}

contract SmartWalletTest is Fixture {
    bytes32 constant MAGIC = 0x6492649264926492649264926492649264926492649264926492649264926492;
    MockWalletFactory factory;
    uint256 ownerPk = 0xC0FFEE;
    address owner;
    bytes32 salt = bytes32(uint256(7));
    address wallet;
    uint256 n;

    function setUp() public override {
        super.setUp();
        factory = new MockWalletFactory();
        owner = vm.addr(ownerPk);
        wallet = factory.getAddress(owner, salt);
    }

    function casual(address winner) internal returns (MatchSettlement.MatchResult memory) {
        return MatchSettlement.MatchResult({
            matchId: keccak256(abi.encode("sw", ++n)),
            playerA: wallet,
            playerB: bob,
            winner: winner,
            deckA: bytes32(0),
            deckB: bytes32(0),
            mode: 0,
            season: 0,
            turns: 12,
            logHash: keccak256("log")
        });
    }

    function sign(uint256 pk, MatchSettlement.MatchResult memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, d.settlement.hashResult(r));
        return abi.encodePacked(rr, s, v);
    }

    function wrap(address fac, bytes memory inner) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                abi.encode(fac, abi.encodeCall(MockWalletFactory.createAccount, (owner, salt)), inner), MAGIC
            );
    }

    function test_undeployedWalletSettlesViaErc6492() public {
        assertEq(wallet.code.length, 0);
        MatchSettlement.MatchResult memory r = casual(wallet);
        d.settlement.settle(r, wrap(address(factory), sign(ownerPk, r)), sign(bobPk, r), "");
        assertTrue(d.settlement.settled(r.matchId));
        assertGt(wallet.code.length, 0, "settlement deployed the wallet");
        assertEq(MockSmartWallet(wallet).owner(), owner);
        assertEq(d.settlement.stats(0, wallet).wins, 1);
        assertEq(d.settlement.stats(0, bob).losses, 1);
    }

    function test_deployedWalletAcceptsWrappedAndPlainSignatures() public {
        factory.createAccount(owner, salt);
        MatchSettlement.MatchResult memory r1 = casual(bob);
        d.settlement.settle(r1, wrap(address(factory), sign(ownerPk, r1)), sign(bobPk, r1), "");
        MatchSettlement.MatchResult memory r2 = casual(wallet);
        d.settlement.settle(r2, sign(ownerPk, r2), sign(bobPk, r2), "");
        assertEq(d.settlement.stats(0, wallet).wins, 1);
        assertEq(d.settlement.stats(0, wallet).losses, 1);
    }

    function test_wrongOwnerRejectedAndNothingDeployed() public {
        MatchSettlement.MatchResult memory r = casual(wallet);
        bytes memory forged = wrap(address(factory), sign(alicePk, r));
        bytes memory sb = sign(bobPk, r);
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.BadSignature.selector, wallet));
        d.settlement.settle(r, forged, sb, "");
        assertEq(wallet.code.length, 0);
    }

    function test_factoryThatDoesNotDeployTheSignerRejected() public {
        MatchSettlement.MatchResult memory r = casual(wallet);
        // Factory calldata for a different salt deploys some other wallet, not the signer.
        bytes memory inner = sign(ownerPk, r);
        bytes memory sig = abi.encodePacked(
            abi.encode(
                address(factory), abi.encodeCall(MockWalletFactory.createAccount, (owner, bytes32(uint256(8)))), inner
            ),
            MAGIC
        );
        bytes memory sb = sign(bobPk, r);
        vm.expectRevert(abi.encodeWithSelector(MatchSettlement.BadSignature.selector, wallet));
        d.settlement.settle(r, sig, sb, "");
    }

    function test_refereePathWithUndeployedWinner() public {
        MatchSettlement.MatchResult memory r = casual(wallet);
        bytes memory sig = wrap(address(factory), sign(ownerPk, r));
        vm.prank(referee);
        d.settlement.settleByReferee(r, sig);
        assertTrue(d.settlement.settled(r.matchId));
        assertEq(d.settlement.stats(0, wallet).wins, 1);
    }

    function test_factoryCannotReenterToSettleTwice() public {
        ReentrantFactory evil = new ReentrantFactory(d.settlement, factory);
        MatchSettlement.MatchResult memory r = casual(wallet);
        bytes memory sa = wrap(address(evil), sign(ownerPk, r));
        bytes memory sb = sign(bobPk, r);
        evil.arm(r, sa, sb);
        d.settlement.settle(r, sa, sb, "");
        assertFalse(evil.reentered(), "re-entrant settle must fail");
        assertEq(d.settlement.stats(0, wallet).wins, 1, "counted once");
    }
}
