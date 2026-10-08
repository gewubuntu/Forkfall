// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CardRegistry} from "../src/CardRegistry.sol";

/// @notice Shared helpers: testnet guard and deployment address book (deployments/<chainId>.json).
abstract contract ForkfallScript is Script {
    error MainnetNotAllowed(uint256 chainId);

    function requireTestnet() internal view {
        uint256 id = block.chainid;
        bool ok = id == 31337 || id == 84532 || id == 46630 || id == 11155111;
        if (!ok) {
            console2.log("Refusing to run on chain", id, "- Forkfall MVP is testnet-only.");
            revert MainnetNotAllowed(id);
        }
    }

    function bookPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function addr(string memory key) internal view returns (address) {
        string memory json = vm.readFile(bookPath());
        return vm.parseJsonAddress(json, string.concat(".", key));
    }

    /// @notice Cards per defineCards transaction. Each card costs about 73k gas, so a batch stays near 3M: far
    ///         under the 16,777,216 gas per-transaction cap (EIP-7825, live on Base) even with forge's 30% margin.
    ///         All 168 Set 1 cards in one call measured 12.3M, which that margin pushed over the cap.
    uint256 internal constant CARD_BATCH = 40;

    /// @notice CardRegistry.defineCards in batches of CARD_BATCH, one transaction each when broadcasting.
    function defineCardsInBatches(
        CardRegistry cards,
        uint16[] memory ids,
        uint8[] memory races,
        uint8[] memory rarities,
        uint8[] memory chains
    ) internal {
        for (uint256 start; start < ids.length; start += CARD_BATCH) {
            uint256 n = ids.length - start < CARD_BATCH ? ids.length - start : CARD_BATCH;
            (uint16[] memory bIds, uint8[] memory bRaces, uint8[] memory bRarities, uint8[] memory bChains) =
                (new uint16[](n), new uint8[](n), new uint8[](n), new uint8[](n));
            for (uint256 i; i < n; ++i) {
                (bIds[i], bRaces[i], bRarities[i], bChains[i]) =
                (ids[start + i], races[start + i], rarities[start + i], chains[start + i]);
            }
            cards.defineCards(bIds, bRaces, bRarities, bChains);
        }
    }
}
