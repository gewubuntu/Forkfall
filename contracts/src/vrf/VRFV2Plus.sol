// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The parts of Chainlink VRF v2.5 that PackSale uses, copied from Chainlink's VRFV2PlusClient and
///         IVRFCoordinatorV2Plus (so the repo doesn't vendor the whole Chainlink library). The coordinator calls
///         back `rawFulfillRandomWords(requestId, randomWords)` on the consumer.
library VRFV2PlusClient {
    bytes4 public constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    struct ExtraArgsV1 {
        bool nativePayment;
    }

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function _argsToBytes(ExtraArgsV1 memory extraArgs) internal pure returns (bytes memory bts) {
        return abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, extraArgs);
    }
}

interface IVRFCoordinatorV2Plus {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId);
}

interface IVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
