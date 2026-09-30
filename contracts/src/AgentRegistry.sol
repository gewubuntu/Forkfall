// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title AgentRegistry
/// @notice Agent wallets register here and play ranked with a visible badge. Each agent names the
///         operator (human or org) responsible for it; operators are capped in how many agents they run.
///         Moderators can ban wallets detected as unregistered bots or colluders from ranked play.
contract AgentRegistry is AccessControl, TestnetOnly {
    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");

    struct Agent {
        bool registered;
        address operator;
        uint64 registeredAt;
        string name;
        string metadataURI; // framework, model card, skill link, etc.
    }

    mapping(address => Agent) public agents;
    mapping(address => uint256) public agentsPerOperator;
    mapping(address => bool) public bannedFromRanked;
    uint256 public maxAgentsPerOperator = 5;

    error AlreadyRegistered(address agent);
    error OperatorCapReached(address operator);
    error NotAgentOrOperator();

    event AgentRegistered(address indexed agent, address indexed operator, string name, string metadataURI);
    event AgentRemoved(address indexed agent);
    event BanUpdated(address indexed player, bool banned, string reason);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MODERATOR_ROLE, admin);
    }

    /// @notice Called by the agent wallet itself.
    function register(address operator, string calldata name, string calldata metadataURI) external {
        if (agents[msg.sender].registered) revert AlreadyRegistered(msg.sender);
        if (agentsPerOperator[operator] >= maxAgentsPerOperator) revert OperatorCapReached(operator);
        agents[msg.sender] = Agent(true, operator, uint64(block.timestamp), name, metadataURI);
        agentsPerOperator[operator] += 1;
        emit AgentRegistered(msg.sender, operator, name, metadataURI);
    }

    function deregister(address agent) external {
        Agent storage a = agents[agent];
        if (msg.sender != agent && msg.sender != a.operator) revert NotAgentOrOperator();
        agentsPerOperator[a.operator] -= 1;
        delete agents[agent];
        emit AgentRemoved(agent);
    }

    function isAgent(address who) external view returns (bool) {
        return agents[who].registered;
    }

    function setBan(address player, bool banned, string calldata reason) external onlyRole(MODERATOR_ROLE) {
        bannedFromRanked[player] = banned;
        emit BanUpdated(player, banned, reason);
    }

    function setMaxAgentsPerOperator(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAgentsPerOperator = n;
    }
}
