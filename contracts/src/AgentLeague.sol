// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

interface IEloTable {
    function expectedScore(uint256 ra, uint256 rb) external view returns (uint256);
}

/// @title AgentLeague
/// @notice Paid league where registered agents play agents. Each agent prepays a balance; every league match
///         costs each side `entryFee`, split into the weekly prize pot, a buyback reserve and operations.
///         Results arrive from MatchSettlement (mode LEAGUE, signed by both agents and co-signed by the
///         referee) and build weekly standings with their own Elo. After a week ends its pot is paid out by a
///         Merkle root to the operators (owners of the agents' ERC-8004 identities) of the best eligible agents.
/// @dev Anti-farming lives here and in the referee: agents of the same operator are never paired, and only the
///      first `RATED_MEETINGS` games between the same pair per week move ratings. Payouts never exceed a
///      week's pot. Test USDC on testnet; a real launch needs a legal review (entry fee + prize).
contract AgentLeague is AccessControl, TestnetOnly, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant REFEREE_ROLE = keccak256("REFEREE_ROLE");
    bytes32 public constant REWARDS_ADMIN_ROLE = keccak256("REWARDS_ADMIN_ROLE");

    uint256 public constant WEEK = 7 days;
    uint256 public constant START_RATING = 1200;
    uint256 public constant K_FACTOR = 32;
    uint32 public constant RATED_MEETINGS = 3;
    uint16 private constant BPS = 10_000;

    IERC20 public immutable token;
    AgentRegistry public immutable agents;
    IEloTable public immutable elo;
    address public settlement;
    uint64 public immutable startTime;

    uint256 public entryFee;
    uint16 public potBps;
    uint16 public buybackBps; // operations get the rest
    address public buybackSink;
    address public opsTreasury;
    uint256 public buybackAccrued;
    uint256 public opsAccrued;

    enum State {
        None,
        Started,
        Settled,
        Cancelled
    }

    struct LeagueMatch {
        address a;
        address b;
        uint32 week;
        State state;
        uint256 fee; // per side, as charged
    }

    struct Standing {
        uint32 games;
        uint32 wins;
        uint32 losses;
        uint32 draws;
        uint32 opponents; // distinct opponents this week
        uint32 rating; // 0 = START_RATING
    }

    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => LeagueMatch) public matches;
    mapping(uint32 => mapping(address => Standing)) private _standings;
    mapping(uint32 => mapping(bytes32 => uint32)) public meetings;
    mapping(uint32 => mapping(address => mapping(address => bool))) private _met;
    mapping(uint32 => address[]) private _players;
    mapping(uint32 => mapping(address => bool)) private _isPlayer;

    mapping(uint32 => uint256) public pot;
    mapping(uint32 => bytes32) public payoutRoot;
    mapping(uint32 => uint64) public claimDeadline;
    mapping(uint32 => uint256) public paid;
    mapping(uint32 => mapping(address => bool)) public claimed;

    error NotAgent(address who);
    error SameOperator(address operator);
    error Banned(address who);
    error InsufficientBalance(address agent, uint256 have, uint256 need);
    error BadMatchState(bytes32 matchId);
    error WrongPlayers(bytes32 matchId);
    error OnlySettlement();
    error ResultsClosed(uint32 week);
    error WeekNotOver(uint32 week);
    error NotPublished(uint32 week);
    error AlreadyClaimed();
    error BadProof();
    error ClaimClosed();
    error ExceedsPot(uint32 week);
    error NotAgentOrOperator();
    error BadSplit();

    event Deposited(address indexed agent, address indexed from, uint256 amount);
    event Withdrawn(address indexed agent, address indexed to, uint256 amount);
    event MatchStarted(bytes32 indexed matchId, uint32 indexed week, address a, address b, uint256 feeEach);
    event MatchCancelled(bytes32 indexed matchId);
    event ResultRecorded(bytes32 indexed matchId, uint32 indexed week, address winner, bool rated);
    event PotFunded(uint32 indexed week, address indexed from, uint256 amount);
    event WeekPublished(uint32 indexed week, bytes32 root, uint256 pot, uint64 claimDeadline);
    event Claimed(uint32 indexed week, address indexed agent, address indexed to, uint256 amount);
    event RolledOver(uint32 indexed fromWeek, uint32 indexed toWeek, uint256 amount);
    event ParamsUpdated(uint256 entryFee, uint16 potBps, uint16 buybackBps, address buybackSink, address opsTreasury);

    constructor(
        address admin,
        IERC20 token_,
        AgentRegistry agents_,
        IEloTable elo_,
        address referee,
        address buybackSink_,
        address opsTreasury_,
        uint256 entryFee_
    ) {
        token = token_;
        agents = agents_;
        elo = elo_;
        startTime = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REWARDS_ADMIN_ROLE, admin);
        _grantRole(REFEREE_ROLE, referee);
        _setParams(entryFee_, 8_000, 1_000, buybackSink_, opsTreasury_);
    }

    // ─── Weeks ──────────────────────────────────────────────────
    function currentWeek() public view returns (uint32) {
        return uint32((block.timestamp - startTime) / WEEK + 1);
    }

    function weekEndsAt(uint32 week) public view returns (uint256) {
        return startTime + uint256(week) * WEEK;
    }

    // ─── Balances (prepaid entry, x402-style micro-payments) ────
    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    /// @notice Operators (or anyone) can top up an agent's league balance.
    function depositFor(address agent, uint256 amount) public nonReentrant {
        token.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[agent] += amount;
        emit Deposited(agent, msg.sender, amount);
    }

    /// @notice The agent wallet or its operator withdraws unused balance to themselves.
    function withdraw(address agent, uint256 amount) external nonReentrant {
        if (msg.sender != agent && msg.sender != operatorOf(agent)) revert NotAgentOrOperator();
        uint256 have = balanceOf[agent];
        if (have < amount) revert InsufficientBalance(agent, have, amount);
        balanceOf[agent] = have - amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(agent, msg.sender, amount);
    }

    /// @notice Owner of the agent's ERC-8004 identity (zero if the wallet is not an agent).
    function operatorOf(address agent) public view returns (address) {
        uint256 id = agents.agentOf(agent);
        if (id == 0 || !agents.isAgent(agent)) return address(0);
        return agents.ownerOf(id);
    }

    /// @notice Can these two agents be paired right now? (both registered, not banned, different operators, funded)
    function canPair(address a, address b) public view returns (bool ok, string memory reason) {
        address oa = operatorOf(a);
        address ob = operatorOf(b);
        if (oa == address(0) || ob == address(0)) return (false, "not a registered agent");
        if (oa == ob) return (false, "same operator");
        if (agents.bannedFromRanked(a) || agents.bannedFromRanked(b)) return (false, "banned");
        if (balanceOf[a] < entryFee || balanceOf[b] < entryFee) return (false, "insufficient league balance");
        return (true, "");
    }

    // ─── Match lifecycle (referee) ──────────────────────────────
    /// @notice Charges both entry fees when a league match actually starts (after both seeds are revealed). They are
    ///         split into the pot, buyback and operations when the result lands, so a cancel simply refunds them.
    function startMatch(bytes32 matchId, address a, address b) external onlyRole(REFEREE_ROLE) {
        if (matches[matchId].state != State.None) revert BadMatchState(matchId);
        address oa = operatorOf(a);
        address ob = operatorOf(b);
        if (oa == address(0)) revert NotAgent(a);
        if (ob == address(0)) revert NotAgent(b);
        if (oa == ob) revert SameOperator(oa);
        if (agents.bannedFromRanked(a)) revert Banned(a);
        if (agents.bannedFromRanked(b)) revert Banned(b);
        uint256 fee = entryFee;
        if (balanceOf[a] < fee) revert InsufficientBalance(a, balanceOf[a], fee);
        if (balanceOf[b] < fee) revert InsufficientBalance(b, balanceOf[b], fee);
        balanceOf[a] -= fee;
        balanceOf[b] -= fee;
        uint32 week = currentWeek();
        matches[matchId] = LeagueMatch(a, b, week, State.Started, fee);
        emit MatchStarted(matchId, week, a, b, fee);
    }

    /// @notice A started match that can never finish (e.g. aborted by the referee): full refund.
    function cancelMatch(bytes32 matchId) external onlyRole(REFEREE_ROLE) {
        LeagueMatch storage m = matches[matchId];
        if (m.state != State.Started) revert BadMatchState(matchId);
        m.state = State.Cancelled;
        balanceOf[m.a] += m.fee;
        balanceOf[m.b] += m.fee;
        emit MatchCancelled(matchId);
    }

    function _split(uint32 week, uint256 total) internal {
        uint256 toPot = (total * potBps) / BPS;
        uint256 toBuyback = (total * buybackBps) / BPS;
        pot[week] += toPot;
        buybackAccrued += toBuyback;
        opsAccrued += total - toPot - toBuyback;
    }

    // ─── Results (from MatchSettlement) ─────────────────────────
    function setSettlement(address settlement_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        settlement = settlement_;
    }

    /// @notice MatchSettlement asks before settling a league result: is this a started match between these two?
    function checkResult(bytes32 matchId, address playerA, address playerB) external view {
        LeagueMatch storage m = matches[matchId];
        if (m.state != State.Started) revert BadMatchState(matchId);
        if (!((m.a == playerA && m.b == playerB) || (m.a == playerB && m.b == playerA))) revert WrongPlayers(matchId);
    }

    function recordResult(bytes32 matchId, address winner) external {
        if (msg.sender != settlement) revert OnlySettlement();
        LeagueMatch storage m = matches[matchId];
        if (m.state != State.Started) revert BadMatchState(matchId);
        uint32 w = m.week;
        if (payoutRoot[w] != bytes32(0)) revert ResultsClosed(w);
        m.state = State.Settled;
        _split(w, 2 * m.fee);
        Standing storage sa = _standing(w, m.a);
        Standing storage sb = _standing(w, m.b);
        sa.games++;
        sb.games++;
        if (winner == address(0)) {
            sa.draws++;
            sb.draws++;
        } else if (winner == m.a) {
            sa.wins++;
            sb.losses++;
        } else {
            sb.wins++;
            sa.losses++;
        }
        if (!_met[w][m.a][m.b]) {
            _met[w][m.a][m.b] = _met[w][m.b][m.a] = true;
            sa.opponents++;
            sb.opponents++;
        }
        bytes32 pair = m.a < m.b ? keccak256(abi.encode(m.a, m.b)) : keccak256(abi.encode(m.b, m.a));
        uint32 n = ++meetings[w][pair];
        bool rated = n <= RATED_MEETINGS;
        if (rated) _updateElo(sa, sb, winner == address(0) ? 500 : winner == m.a ? 1000 : 0);
        emit ResultRecorded(matchId, w, winner, rated);
    }

    function _standing(uint32 week, address agent) internal returns (Standing storage s) {
        if (!_isPlayer[week][agent]) {
            _isPlayer[week][agent] = true;
            _players[week].push(agent);
        }
        s = _standings[week][agent];
    }

    function _updateElo(Standing storage a, Standing storage b, uint256 scoreA) internal {
        uint256 ra = a.rating == 0 ? START_RATING : a.rating;
        uint256 rb = b.rating == 0 ? START_RATING : b.rating;
        int256 delta = (int256(K_FACTOR) * (int256(scoreA) - int256(elo.expectedScore(ra, rb)))) / 1000;
        int256 na = int256(ra) + delta;
        int256 nb = int256(rb) - delta;
        a.rating = uint32(uint256(na < 100 ? int256(100) : na));
        b.rating = uint32(uint256(nb < 100 ? int256(100) : nb));
    }

    function standing(uint32 week, address agent) external view returns (Standing memory s) {
        s = _standings[week][agent];
        if (s.rating == 0) s.rating = uint32(START_RATING);
    }

    function players(uint32 week) external view returns (address[] memory) {
        return _players[week];
    }

    // ─── Pots and payouts ───────────────────────────────────────
    /// @notice Anyone can add to a week's pot (sponsors, the treasury bootstrapping a new league).
    function fundPot(uint32 week, uint256 amount) external nonReentrant {
        if (week < currentWeek()) revert BadMatchState(bytes32(uint256(week)));
        token.safeTransferFrom(msg.sender, address(this), amount);
        pot[week] += amount;
        emit PotFunded(week, msg.sender, amount);
    }

    /// @notice Publish a finished week's payouts. Leaf = keccak256(bytes.concat(keccak256(abi.encode(agent, amount)))).
    function publishWeek(uint32 week, bytes32 root, uint64 deadline) external onlyRole(REWARDS_ADMIN_ROLE) {
        if (week >= currentWeek()) revert WeekNotOver(week);
        payoutRoot[week] = root;
        claimDeadline[week] = deadline;
        emit WeekPublished(week, root, pot[week], deadline);
    }

    /// @notice Anyone may trigger a claim; the prize goes to the agent's current operator (or the agent itself if
    ///         it no longer has one). Total claims can never exceed the week's pot.
    function claim(uint32 week, address agent, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        bytes32 root = payoutRoot[week];
        if (root == bytes32(0)) revert NotPublished(week);
        if (claimDeadline[week] != 0 && block.timestamp > claimDeadline[week]) revert ClaimClosed();
        if (claimed[week][agent]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(agent, amount))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert BadProof();
        if (paid[week] + amount > pot[week]) revert ExceedsPot(week);
        claimed[week][agent] = true;
        paid[week] += amount;
        address op = operatorOf(agent);
        address to = op == address(0) ? agent : op;
        token.safeTransfer(to, amount);
        emit Claimed(week, agent, to, amount);
    }

    /// @notice After the claim window, unclaimed prizes roll into the current week's pot.
    function rollover(uint32 week) external onlyRole(REWARDS_ADMIN_ROLE) {
        if (week >= currentWeek() || claimDeadline[week] == 0 || block.timestamp <= claimDeadline[week]) {
            revert WeekNotOver(week);
        }
        uint256 left = pot[week] - paid[week];
        uint32 to = currentWeek();
        pot[week] = paid[week];
        pot[to] += left;
        emit RolledOver(week, to, left);
    }

    /// @notice Send the accrued buyback and operations shares to their sinks (buyback runs off-chain until a token exists).
    function sweep() external nonReentrant {
        uint256 bb = buybackAccrued;
        uint256 ops = opsAccrued;
        buybackAccrued = 0;
        opsAccrued = 0;
        if (bb > 0) token.safeTransfer(buybackSink, bb);
        if (ops > 0) token.safeTransfer(opsTreasury, ops);
    }

    // ─── Admin ──────────────────────────────────────────────────
    function setParams(
        uint256 entryFee_,
        uint16 potBps_,
        uint16 buybackBps_,
        address buybackSink_,
        address opsTreasury_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setParams(entryFee_, potBps_, buybackBps_, buybackSink_, opsTreasury_);
    }

    function _setParams(uint256 fee, uint16 potBps_, uint16 buybackBps_, address bb, address ops) internal {
        if (uint256(potBps_) + buybackBps_ > BPS || bb == address(0) || ops == address(0)) revert BadSplit();
        entryFee = fee;
        potBps = potBps_;
        buybackBps = buybackBps_;
        buybackSink = bb;
        opsTreasury = ops;
        emit ParamsUpdated(fee, potBps_, buybackBps_, bb, ops);
    }
}
