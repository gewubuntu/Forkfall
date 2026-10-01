// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./Fixture.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {MockSmartWallet} from "./mocks/MockSmartWallet.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract AgentsTest is Fixture {
    uint256 botPk = 0xB07;
    address bot;

    function setUp() public override {
        super.setUp();
        bot = vm.addr(botPk);
    }

    function proof(uint256 pk, uint256 agentId, address wallet, address owner, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d.agents.agentWalletDigest(agentId, wallet, owner, deadline));
        return abi.encodePacked(r, s, v);
    }

    function test_registerOverloadsMintAndDefaultWalletToOwner() public {
        AgentRegistry.MetadataEntry[] memory md = new AgentRegistry.MetadataEntry[](1);
        md[0] = AgentRegistry.MetadataEntry("framework", bytes("forkfall-sdk"));
        vm.expectEmit(true, true, true, true, address(d.agents));
        emit AgentRegistry.Registered(1, "ipfs://a", alice);
        vm.prank(alice);
        uint256 a = d.agents.register("ipfs://a", md);
        vm.prank(bob);
        uint256 b = d.agents.register("ipfs://b");
        vm.prank(bot);
        uint256 c = d.agents.register();

        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(c, 3);
        assertEq(d.agents.ownerOf(a), alice);
        assertEq(d.agents.tokenURI(a), "ipfs://a");
        assertEq(string(d.agents.getMetadata(a, "framework")), "forkfall-sdk");
        assertEq(d.agents.getAgentWallet(a), alice);
        assertEq(d.agents.getMetadata(a, "agentWallet"), abi.encodePacked(alice));
        assertTrue(d.agents.isAgent(alice));
        assertEq(d.agents.agentOf(bot), c);
        assertEq(d.agents.nextAgentId(), 4);
        assertTrue(d.agents.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(d.agents.supportsInterface(0x780e9d63)); // ERC-721 Enumerable
    }

    function test_agentWalletIsReserved() public {
        AgentRegistry.MetadataEntry[] memory md = new AgentRegistry.MetadataEntry[](1);
        md[0] = AgentRegistry.MetadataEntry("agentWallet", abi.encodePacked(bob));
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.ReservedKey.selector);
        d.agents.register("ipfs://a", md);

        vm.prank(alice);
        uint256 id = d.agents.register("ipfs://a");
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.ReservedKey.selector);
        d.agents.setMetadata(id, "agentWallet", abi.encodePacked(bob));
    }

    function test_operatorLinksAgentWalletWithItsSignature() public {
        vm.prank(alice);
        uint256 id = d.agents.register("ipfs://a");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = proof(botPk, id, bot, alice, deadline);
        vm.prank(alice);
        d.agents.setAgentWallet(id, bot, deadline, sig);
        assertEq(d.agents.getAgentWallet(id), bot);
        assertTrue(d.agents.isAgent(bot));
        assertFalse(d.agents.isAgent(alice), "operator is not the agent once the wallet is linked");

        vm.prank(alice);
        d.agents.unsetAgentWallet(id);
        assertFalse(d.agents.isAgent(bot));
        assertEq(d.agents.getAgentWallet(id), address(0));
    }

    function test_walletProofMustMatchWalletOwnerAndDeadline() public {
        vm.prank(alice);
        uint256 id = d.agents.register();
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory wrongSigner = proof(bobPk, id, bot, alice, deadline);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.BadWalletSignature.selector);
        d.agents.setAgentWallet(id, bot, deadline, wrongSigner);

        bytes memory forOtherOwner = proof(botPk, id, bot, bob, deadline);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.BadWalletSignature.selector);
        d.agents.setAgentWallet(id, bot, deadline, forOtherOwner);

        bytes memory ok = proof(botPk, id, bot, alice, deadline);
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.SignatureExpired.selector);
        d.agents.setAgentWallet(id, bot, deadline, ok);

        uint256 later = block.timestamp + 1;
        bytes memory bobsProof = proof(botPk, id, bot, bob, later);
        vm.prank(bob); // not the owner
        vm.expectRevert(AgentRegistry.NotAuthorized.selector);
        d.agents.setAgentWallet(id, bot, later, bobsProof);
    }

    function test_smartWalletAgentViaErc1271() public {
        MockSmartWallet w = new MockSmartWallet(bot);
        vm.prank(alice);
        uint256 id = d.agents.register();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = proof(botPk, id, address(w), alice, deadline);
        vm.prank(alice);
        d.agents.setAgentWallet(id, address(w), deadline, sig);
        assertTrue(d.agents.isAgent(address(w)));
    }

    function test_registerWithWalletNeverFlagsTheOperator() public {
        uint256 next = d.agents.nextAgentId();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = proof(botPk, next, bot, alice, deadline);
        vm.prank(alice);
        uint256 id = d.agents.registerWithWallet("ipfs://bot", next, bot, deadline, sig);
        assertEq(id, next);
        assertTrue(d.agents.isAgent(bot));
        assertFalse(d.agents.isAgent(alice));
        assertEq(d.agents.walletLinks(alice), 0);

        // A stale prediction (someone registered first) reverts instead of linking to the wrong id.
        bytes memory stale = proof(botPk, next, bot, alice, deadline);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentIdTaken.selector, next, next + 1));
        d.agents.registerWithWallet("ipfs://bot2", next, bot, deadline, stale);
    }

    function test_transferClearsWalletAndBurnDeregisters() public {
        vm.prank(bot);
        uint256 id = d.agents.register("ipfs://self");
        assertTrue(d.agents.isAgent(bot));
        vm.prank(bot);
        d.agents.transferFrom(bot, alice, id);
        assertEq(d.agents.getAgentWallet(id), address(0), "cleared on transfer");
        assertFalse(d.agents.isAgent(bot));
        assertFalse(d.agents.isAgent(alice));

        // An approved operator may manage the agent too.
        vm.prank(alice);
        d.agents.approve(bob, id);
        vm.prank(bob);
        d.agents.setAgentURI(id, "ipfs://new");
        assertEq(d.agents.tokenURI(id), "ipfs://new");
        vm.prank(bob);
        d.agents.burn(id);
        assertEq(d.agents.balanceOf(alice), 0);
    }

    function test_operatorCapAppliesToMintsAndTransfers() public {
        vm.startPrank(alice);
        for (uint256 i; i < 5; ++i) {
            d.agents.register();
        }
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.OperatorCapReached.selector, alice));
        d.agents.register();
        vm.stopPrank();

        vm.prank(bob);
        uint256 id = d.agents.register();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.OperatorCapReached.selector, alice));
        d.agents.transferFrom(bob, alice, id);
        assertEq(d.agents.tokenOfOwnerByIndex(alice, 4), 5);
    }

    function test_onlyModeratorsBan() public {
        bytes32 role = d.agents.MODERATOR_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        d.agents.setBan(bob, true, "nope");
        vm.prank(admin);
        d.agents.setBan(bob, true, "collusion");
        assertTrue(d.agents.bannedFromRanked(bob));
    }

    function test_refereeAttestsTestnetHumans() public {
        bytes32 testnet = keccak256("testnet");
        vm.prank(referee);
        d.humans.attest(alice, testnet, uint64(block.timestamp + 30 days));
        assertTrue(d.humans.isVerifiedHuman(alice));
        vm.warp(block.timestamp + 31 days);
        assertFalse(d.humans.isVerifiedHuman(alice), "testnet attestations expire");
    }
}
