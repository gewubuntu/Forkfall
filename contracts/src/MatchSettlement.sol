// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {DeckRegistry} from "./DeckRegistry.sol";
import {HumanRegistry} from "./HumanRegistry.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title MatchSettlement
/// @notice Off-chain moves, on-chain truth. Matches are played as signed moves against the shared rules
///         engine; only the result lands here, signed by both players (EIP-712; ERC-1271 smart wallets OK).
///         If the loser refuses to sign or times out, a REFEREE (who replays the full signed move log with the
///         same engine) may settle with the winner's signature alone. That referee trust is the testnet
///         stand-in for the GDD's on-chain replay dispute path.
///         Smart-wallet players may sign before their wallet exists: ERC-6492 signatures carry the wallet's
///         factory call, which this contract runs (deploying the wallet) before the ERC-1271 check.
contract MatchSettlement is AccessControl, EIP712, TestnetOnly, ReentrancyGuardTransient {
    bytes32 public constant REFEREE_ROLE = keccak256("REFEREE_ROLE");
    bytes32 public constant SEASON_ADMIN_ROLE = keccak256("SEASON_ADMIN_ROLE");

    uint8 public constant MODE_CASUAL = 0;
    uint8 public constant MODE_RANKED = 1;
    uint8 public constant MODE_HUMAN = 2;

    /// @dev ERC-6492 suffix marking a signature wrapped as abi.encode(factory, factoryCalldata, signature).
    bytes32 private constant ERC6492_MAGIC = 0x6492649264926492649264926492649264926492649264926492649264926492;

    uint256 public constant START_RATING = 1200;
    uint256 public constant K_FACTOR = 32;

    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "MatchResult(bytes32 matchId,address playerA,address playerB,address winner,bytes32 deckA,bytes32 deckB,uint8 mode,uint32 season,uint16 turns,bytes32 logHash)"
    );

    struct MatchResult {
        bytes32 matchId;
        address playerA;
        address playerB;
        address winner; // address(0) = draw
        bytes32 deckA; // DeckRegistry id; required for ranked/human
        bytes32 deckB;
        uint8 mode;
        uint32 season;
        uint16 turns;
        bytes32 logHash; // hash chain head over every signed move
    }

    struct Stats {
        uint32 wins;
        uint32 losses;
        uint32 draws;
        uint32 rating; // 0 = unrated (treated as START_RATING)
    }

    AgentRegistry public immutable agentRegistry;
    DeckRegistry public immutable deckRegistry;
    HumanRegistry public immutable humanRegistry;

    uint32 public currentSeason = 1;
    mapping(bytes32 => bool) public settled;
    mapping(uint32 => mapping(address => Stats)) private _stats;

    // Elo expected score (x1000) for rating gaps 0, 25, 50, ... 800.
    uint16[33] private ELO = [
        500,
        536,
        571,
        606,
        640,
        673,
        703,
        733,
        760,
        785,
        808,
        830,
        849,
        867,
        882,
        896,
        909,
        920,
        930,
        939,
        947,
        954,
        960,
        965,
        969,
        973,
        977,
        980,
        983,
        985,
        987,
        989,
        990
    ];

    error AlreadySettled(bytes32 matchId);
    error BadPlayers();
    error BadWinner();
    error BadSignature(address signer);
    error WrongSeason(uint32 season);
    error InvalidDeck(address player);
    error Banned(address player);
    error NotHuman(address player);
    error UnknownMode(uint8 mode);
    error MissingRefereeSignature();

    event MatchSettled(
        bytes32 indexed matchId,
        address indexed winner,
        address indexed loser,
        uint8 mode,
        uint32 season,
        uint16 turns,
        bytes32 logHash,
        bool byReferee
    );
    event RatingChanged(uint32 indexed season, address indexed player, uint32 oldRating, uint32 newRating);
    event SeasonStarted(uint32 season);

    constructor(address admin, AgentRegistry agents_, DeckRegistry decks_, HumanRegistry humans_)
        EIP712("Forkfall", "1")
    {
        agentRegistry = agents_;
        deckRegistry = decks_;
        humanRegistry = humans_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SEASON_ADMIN_ROLE, admin);
    }

    // ─── Settlement ─────────────────────────────────────────────
    function hashResult(MatchResult calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESULT_TYPEHASH,
                    r.matchId,
                    r.playerA,
                    r.playerB,
                    r.winner,
                    r.deckA,
                    r.deckB,
                    r.mode,
                    r.season,
                    r.turns,
                    r.logHash
                )
            )
        );
    }

    /// @notice Happy path: both players signed the final result. Ranked and Human-queue results also need the
    ///         referee's co-signature, so two colluding wallets cannot fabricate matches to farm rating or rewards.
    ///         Casual results need only the two players (pass empty `refereeSig`).
    function settle(MatchResult calldata r, bytes calldata sigA, bytes calldata sigB, bytes calldata refereeSig)
        external
        nonReentrant
    {
        bytes32 digest = _precheck(r);
        if (!_isValidSignature(r.playerA, digest, sigA)) revert BadSignature(r.playerA);
        if (!_isValidSignature(r.playerB, digest, sigB)) revert BadSignature(r.playerB);
        if (r.mode != MODE_CASUAL) {
            (address referee, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, refereeSig);
            if (err != ECDSA.RecoverError.NoError || !hasRole(REFEREE_ROLE, referee)) revert MissingRefereeSignature();
        }
        _record(r, false);
    }

    /// @notice Dispute / timeout path: the referee replayed the move log and co-signs with the winner.
    function settleByReferee(MatchResult calldata r, bytes calldata winnerSig)
        external
        onlyRole(REFEREE_ROLE)
        nonReentrant
    {
        bytes32 digest = _precheck(r);
        if (r.winner == address(0)) revert BadWinner();
        if (!_isValidSignature(r.winner, digest, winnerSig)) revert BadSignature(r.winner);
        _record(r, true);
    }

    function _precheck(MatchResult calldata r) internal view returns (bytes32) {
        if (settled[r.matchId]) revert AlreadySettled(r.matchId);
        if (r.playerA == address(0) || r.playerB == address(0) || r.playerA == r.playerB) revert BadPlayers();
        if (r.winner != address(0) && r.winner != r.playerA && r.winner != r.playerB) revert BadWinner();
        if (r.mode > MODE_HUMAN) revert UnknownMode(r.mode);
        if (r.mode != MODE_CASUAL) {
            if (r.season != currentSeason) revert WrongSeason(r.season);
            _checkRankedPlayer(r.playerA, r.deckA, r.mode);
            _checkRankedPlayer(r.playerB, r.deckB, r.mode);
        }
        return hashResult(r);
    }

    /// @dev EOA (ECDSA), deployed smart wallet (ERC-1271), or not-yet-deployed smart wallet (ERC-6492).
    ///      For 6492, the factory call is the wallet's own deterministic deployment, so anyone may run it; it
    ///      only runs if the wallet is missing or rejects the inner signature (6492 "prepare" case). Settlement
    ///      is nonReentrant, so the factory cannot re-enter to settle twice.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata sig) internal returns (bool) {
        if (sig.length < 32 || bytes32(sig[sig.length - 32:]) != ERC6492_MAGIC) {
            return SignatureChecker.isValidSignatureNow(signer, digest, sig);
        }
        (address factory, bytes memory factoryCalldata, bytes memory inner) =
            abi.decode(sig[:sig.length - 32], (address, bytes, bytes));
        if (signer.code.length > 0 && SignatureChecker.isValidERC1271SignatureNow(signer, digest, inner)) return true;
        (bool ok,) = factory.call(factoryCalldata);
        if (!ok || signer.code.length == 0) return false;
        return SignatureChecker.isValidERC1271SignatureNow(signer, digest, inner);
    }

    function _checkRankedPlayer(address p, bytes32 deck, uint8 mode) internal view {
        if (agentRegistry.bannedFromRanked(p)) revert Banned(p);
        if (!deckRegistry.isValidFor(deck, p, true)) revert InvalidDeck(p);
        if (mode == MODE_HUMAN && (!humanRegistry.isVerifiedHuman(p) || agentRegistry.isAgent(p))) revert NotHuman(p);
    }

    function _record(MatchResult calldata r, bool byReferee) internal {
        settled[r.matchId] = true;
        address loser = r.winner == address(0) ? address(0) : (r.winner == r.playerA ? r.playerB : r.playerA);
        uint32 season = r.mode == MODE_CASUAL ? 0 : r.season; // casual stats are tracked under season 0
        Stats storage a = _stats[season][r.playerA];
        Stats storage b = _stats[season][r.playerB];
        if (r.winner == address(0)) {
            a.draws++;
            b.draws++;
        } else {
            _stats[season][r.winner].wins++;
            _stats[season][loser].losses++;
        }
        if (r.mode != MODE_CASUAL) _updateElo(season, r.playerA, r.playerB, r.winner);
        emit MatchSettled(r.matchId, r.winner, loser, r.mode, r.season, r.turns, r.logHash, byReferee);
    }

    function _updateElo(uint32 season, address pa, address pb, address winner) internal {
        Stats storage a = _stats[season][pa];
        Stats storage b = _stats[season][pb];
        uint256 ra = a.rating == 0 ? START_RATING : a.rating;
        uint256 rb = b.rating == 0 ? START_RATING : b.rating;
        uint256 ea = expectedScore(ra, rb); // x1000
        uint256 sa = winner == address(0) ? 500 : (winner == pa ? 1000 : 0);
        // delta = K * (S - E) / 1000, applied symmetrically.
        int256 delta = (int256(K_FACTOR) * (int256(sa) - int256(ea))) / 1000;
        uint32 na = uint32(uint256(_clampRating(int256(ra) + delta)));
        uint32 nb = uint32(uint256(_clampRating(int256(rb) - delta)));
        emit RatingChanged(season, pa, uint32(ra), na);
        emit RatingChanged(season, pb, uint32(rb), nb);
        a.rating = na;
        b.rating = nb;
    }

    function _clampRating(int256 r) internal pure returns (int256) {
        return r < 100 ? int256(100) : r;
    }

    /// @notice Elo expected score for `ra` vs `rb`, scaled x1000 (lookup in 25-point steps).
    function expectedScore(uint256 ra, uint256 rb) public view returns (uint256) {
        uint256 diff = ra > rb ? ra - rb : rb - ra;
        uint256 idx = diff / 25;
        uint256 e = idx >= ELO.length ? ELO[ELO.length - 1] : ELO[idx];
        return ra >= rb ? e : 1000 - e;
    }

    // ─── Views & seasons ────────────────────────────────────────
    function stats(uint32 season, address player) external view returns (Stats memory s) {
        s = _stats[season][player];
        if (s.rating == 0) s.rating = uint32(START_RATING);
    }

    function startSeason(uint32 season) external onlyRole(SEASON_ADMIN_ROLE) {
        require(season > currentSeason, "MatchSettlement: season must increase");
        currentSeason = season;
        emit SeasonStarted(season);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
