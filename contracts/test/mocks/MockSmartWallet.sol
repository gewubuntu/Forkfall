// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Minimal ERC-1271 smart wallet with one ECDSA owner (stand-in for Base Account / Coinbase Smart Wallet).
contract MockSmartWallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return
            err == ECDSA.RecoverError.NoError && signer == owner
                ? IERC1271.isValidSignature.selector
                : bytes4(0xffffffff);
    }
}

/// @notice CREATE2 factory, so the wallet address is known (and can sign via ERC-6492) before deployment.
contract MockWalletFactory {
    function createAccount(address owner, bytes32 salt) external returns (address wallet) {
        wallet = getAddress(owner, salt);
        if (wallet.code.length == 0) new MockSmartWallet{salt: salt}(owner);
    }

    function getAddress(address owner, bytes32 salt) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(abi.encodePacked(type(MockSmartWallet).creationCode, abi.encode(owner)))
            )
        );
        return address(uint160(uint256(h)));
    }
}
