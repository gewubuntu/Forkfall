// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVRFConsumer, IVRFCoordinatorV2Plus, VRFV2PlusClient} from "./VRFV2Plus.sol";
import {TestnetOnly} from "../TestnetOnly.sol";

/// @title VRFCoordinatorMock
/// @notice Local stand-in for the Chainlink VRF v2.5 coordinator (Anvil only; real testnets use Chainlink's).
///         Requests queue up; anyone may fulfill them (the referee's dev loop does, a few seconds later), with
///         words derived from the request and a recent block hash. NOT random enough for anything but local dev.
contract VRFCoordinatorMock is IVRFCoordinatorV2Plus, TestnetOnly {
    struct Request {
        address consumer;
        uint32 numWords;
        uint32 callbackGasLimit;
        bool done;
    }

    Request[] public requests;
    uint256 public nextToFulfill;

    event RandomWordsRequested(uint256 indexed requestId, address indexed consumer, uint32 numWords);
    event RandomWordsFulfilled(uint256 indexed requestId, bool success);

    constructor() {
        require(block.chainid == ANVIL, "VRFCoordinatorMock: local Anvil only");
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId) {
        requestId = requests.length + 1; // 0 means "no request" to consumers
        requests.push(Request(msg.sender, req.numWords, req.callbackGasLimit, false));
        emit RandomWordsRequested(requestId, msg.sender, req.numWords);
    }

    function pending() external view returns (uint256) {
        return requests.length - nextToFulfill;
    }

    /// @notice Fulfill every queued request (in order). Words: keccak(request id, i, previous block hash).
    function fulfillPending() external {
        while (nextToFulfill < requests.length) {
            uint256 requestId = nextToFulfill + 1;
            Request storage r = requests[nextToFulfill++];
            uint256[] memory words = new uint256[](r.numWords);
            for (uint256 i; i < r.numWords; ++i) {
                words[i] = uint256(keccak256(abi.encode(requestId, i, blockhash(block.number - 1))));
            }
            r.done = true;
            (bool ok,) = r.consumer.call{gas: r.callbackGasLimit}(
                abi.encodeCall(IVRFConsumer.rawFulfillRandomWords, (requestId, words))
            );
            emit RandomWordsFulfilled(requestId, ok);
        }
    }
}
