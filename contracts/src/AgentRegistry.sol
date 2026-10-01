// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title AgentRegistry (ERC-8004 Identity Registry)
/// @notice Agents are ERC-721 tokens (agentId = tokenId, agentURI = tokenURI → ERC-8004 registration file), owned
///         by the operator responsible for them. The reserved `agentWallet` is the wallet the agent plays from: it
///         starts as the owner, changes only with a signature from the new wallet (EIP-712 or ERC-1271), and is
///         cleared on transfer. A wallet is an agent in Forkfall while it is some agent's `agentWallet`: it gets the
///         agent badge and stays out of the Human queue. Owners may hold at most `maxAgentsPerOperator` agents.
///         Moderators can ban wallets (registered or not) from ranked play.
/// @dev Implements the Identity Registry of ERC-8004 (draft): register overloads, agentURI, on-chain metadata,
///      agentWallet. The draft leaves the agentWallet proof's EIP-712 struct open; this registry uses
///      AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline) under the
///      ("Forkfall AgentRegistry", "1") domain. Extensions: registerWithWallet, burn, bans, isAgent.
contract AgentRegistry is ERC721URIStorage, ERC721Enumerable, AccessControl, EIP712, TestnetOnly {
    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");
    bytes32 public constant AGENT_WALLET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    string private constant AGENT_WALLET_KEY = "agentWallet";

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    uint256 private _nextId = 1;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => address) private _agentWallet;
    /// @notice How many agents currently use this wallet as their agentWallet.
    mapping(address => uint256) public walletLinks;
    /// @notice The agent most recently linked to this wallet (0 = none), for display.
    mapping(address => uint256) public agentOf;
    mapping(address => bool) public bannedFromRanked;
    uint256 public maxAgentsPerOperator = 5;

    error OperatorCapReached(address operator);
    error NotAuthorized();
    error ReservedKey();
    error SignatureExpired();
    error BadWalletSignature();
    error AgentIdTaken(uint256 expected, uint256 next);

    // ERC-8004
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    // Forkfall
    event BanUpdated(address indexed player, bool banned, string reason);

    constructor(address admin) ERC721("Forkfall Agents", "FFAGENT") EIP712("Forkfall AgentRegistry", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MODERATOR_ROLE, admin);
    }

    // ─── Registration (ERC-8004) ────────────────────────────────
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _register(agentURI);
        for (uint256 i; i < metadata.length; ++i) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI);
    }

    function register() external returns (uint256 agentId) {
        agentId = _register("");
    }

    /// @notice Extension: mint and link the agent's own wallet in one transaction, so the owner's wallet is never
    ///         flagged as the agent. The wallet signs AgentWalletSet for `expectedAgentId` (see `nextAgentId`).
    function registerWithWallet(
        string calldata agentURI,
        uint256 expectedAgentId,
        address wallet,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 agentId) {
        if (expectedAgentId != _nextId) revert AgentIdTaken(expectedAgentId, _nextId);
        _checkWalletProof(expectedAgentId, wallet, msg.sender, deadline, signature);
        agentId = _register(agentURI);
        _setAgentWallet(agentId, wallet);
    }

    function nextAgentId() external view returns (uint256) {
        return _nextId;
    }

    function _register(string memory agentURI) internal returns (uint256 agentId) {
        agentId = _nextId++;
        _mint(msg.sender, agentId);
        if (bytes(agentURI).length > 0) _setTokenURI(agentId, agentURI);
        _setAgentWallet(agentId, msg.sender);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAuthorized(agentId);
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    // ─── Metadata (ERC-8004) ────────────────────────────────────
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        if (_isAgentWalletKey(metadataKey)) return abi.encodePacked(_agentWallet[agentId]);
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _requireAuthorized(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) internal {
        if (_isAgentWalletKey(key)) revert ReservedKey();
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    // ─── Agent wallet (ERC-8004) ────────────────────────────────
    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallet[agentId];
    }

    /// @notice Owner (or approved operator) links the wallet the agent plays from; that wallet must sign
    ///         AgentWalletSet(agentId, newWallet, owner, deadline) (EIP-712 for EOAs, ERC-1271 for contracts).
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        address owner = _requireAuthorized(agentId);
        _checkWalletProof(agentId, newWallet, owner, deadline, signature);
        _setAgentWallet(agentId, newWallet);
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAuthorized(agentId);
        _setAgentWallet(agentId, address(0));
    }

    function agentWalletDigest(uint256 agentId, address newWallet, address owner, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, owner, deadline)));
    }

    function _checkWalletProof(uint256 agentId, address wallet, address owner, uint256 deadline, bytes calldata sig)
        internal
        view
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = agentWalletDigest(agentId, wallet, owner, deadline);
        if (wallet == address(0) || !SignatureChecker.isValidSignatureNow(wallet, digest, sig)) {
            revert BadWalletSignature();
        }
    }

    function _setAgentWallet(uint256 agentId, address wallet) internal {
        address old = _agentWallet[agentId];
        if (old == wallet) return;
        if (old != address(0)) {
            walletLinks[old] -= 1;
            if (agentOf[old] == agentId) agentOf[old] = 0;
        }
        _agentWallet[agentId] = wallet;
        if (wallet != address(0)) {
            walletLinks[wallet] += 1;
            agentOf[wallet] = agentId;
        }
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encodePacked(wallet));
    }

    // ─── Forkfall extensions ────────────────────────────────────
    /// @notice A wallet is an agent while it is the agentWallet of a registered agent.
    function isAgent(address who) external view returns (bool) {
        return walletLinks[who] > 0;
    }

    /// @notice Deregister: the owner (or approved operator) burns the agent; its wallet stops being an agent.
    function burn(uint256 agentId) external {
        _requireAuthorized(agentId);
        _burn(agentId);
    }

    function setBan(address player, bool banned, string calldata reason) external onlyRole(MODERATOR_ROLE) {
        bannedFromRanked[player] = banned;
        emit BanUpdated(player, banned, reason);
    }

    function setMaxAgentsPerOperator(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAgentsPerOperator = n;
    }

    function _requireAuthorized(uint256 agentId) internal view returns (address owner) {
        owner = _requireOwned(agentId);
        if (!_isAuthorized(owner, msg.sender, agentId)) revert NotAuthorized();
    }

    function _isAgentWalletKey(string memory key) private pure returns (bool) {
        return keccak256(bytes(key)) == keccak256(bytes(AGENT_WALLET_KEY));
    }

    // ─── ERC-721 plumbing ───────────────────────────────────────
    /// @dev Mints and transfers respect the operator cap; transfers and burns clear the agent wallet (ERC-8004).
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address from)
    {
        if (to != address(0) && balanceOf(to) >= maxAgentsPerOperator) {
            revert OperatorCapReached(to);
        }
        from = super._update(to, tokenId, auth);
        if (from != address(0) && from != to) _setAgentWallet(tokenId, address(0));
    }

    function _increaseBalance(address account, uint128 amount) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC721Enumerable, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
