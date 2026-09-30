// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title HumanRegistry
/// @notice Gate for the Human queue. The proof-of-personhood method is still an open question in the GDD,
///         so verification is pluggable: attestor services (Coinbase Verifications via EAS, World ID, Self,
///         Human Passport) hold ATTESTOR_ROLE and record which method verified a wallet.
contract HumanRegistry is AccessControl, TestnetOnly {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");

    // Method ids (bytes32 labels): keccak256("coinbase"), keccak256("worldid"), keccak256("self"), keccak256("passport")
    struct Verification {
        bytes32 method;
        uint64 verifiedAt;
        uint64 expiresAt; // 0 = no expiry
    }

    mapping(address => Verification) public verification;
    mapping(bytes32 => bool) public methodEnabled;

    error MethodDisabled(bytes32 method);

    event HumanVerified(address indexed player, bytes32 indexed method, uint64 expiresAt);
    event HumanRevoked(address indexed player);
    event MethodSet(bytes32 indexed method, bool enabled);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, admin);
        methodEnabled[keccak256("coinbase")] = true;
        methodEnabled[keccak256("worldid")] = true;
        methodEnabled[keccak256("self")] = true;
        methodEnabled[keccak256("passport")] = true;
    }

    function setMethod(bytes32 method, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        methodEnabled[method] = enabled;
        emit MethodSet(method, enabled);
    }

    function attest(address player, bytes32 method, uint64 expiresAt) external onlyRole(ATTESTOR_ROLE) {
        if (!methodEnabled[method]) revert MethodDisabled(method);
        verification[player] = Verification(method, uint64(block.timestamp), expiresAt);
        emit HumanVerified(player, method, expiresAt);
    }

    function revoke(address player) external onlyRole(ATTESTOR_ROLE) {
        delete verification[player];
        emit HumanRevoked(player);
    }

    function isVerifiedHuman(address player) public view returns (bool) {
        Verification memory v = verification[player];
        if (v.verifiedAt == 0 || !methodEnabled[v.method]) return false;
        return v.expiresAt == 0 || v.expiresAt > block.timestamp;
    }
}
