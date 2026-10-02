import { parseAbi } from 'viem';

/** Minimal ABIs for the hub contracts the apps call. Custom errors are included so reverts decode. */
export const cardRegistryAbi = parseAbi([
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'function STARTER_OFFSET() view returns (uint256)',
  'error Soulbound(uint256 id)',
  'error UnknownCard(uint256 id)',
]);

export const starterDecksAbi = parseAbi([
  'function claim(uint8 race)',
  'function claimed(address player, uint8 race) view returns (bool)',
  'event StarterClaimed(address indexed player, uint8 indexed race)',
  'error AlreadyClaimed(address player, uint8 race)',
  'error BadRace(uint8 race)',
]);

export const packSaleAbi = parseAbi([
  'function ethPrice() view returns (uint256)',
  'function tokenPrice(address token) view returns (uint256)',
  'function MAX_PACKS_PER_TX() view returns (uint256)',
  'function buyWithEth(uint256 count) payable returns (uint256 firstId)',
  'function buyWithToken(address token, uint256 count) returns (uint256 firstId)',
  'function open(uint256 packId) returns (uint256[5] ids)',
  'function packIdsOf(address owner) view returns (uint256[])',
  'function packsSinceLegendary(address who) view returns (uint256)',
  'function packsUntilPity(address who) view returns (uint256)',
  'function PITY_PACKS() view returns (uint256)',
  'function FOIL_BPS() view returns (uint256)',
  'function roll(bytes32 rand, address opener, bool forceLegendary) view returns (uint256[5] ids)',
  'function packs(uint256 id) view returns (address owner, uint64 revealBlock, bool opened, uint8 kind)',
  'function buyWithEthOf(uint8 kind, uint256 count) payable returns (uint256 firstId)',
  'function buyWithTokenOf(address token, uint8 kind, uint256 count) returns (uint256 firstId)',
  'function quoteEth(uint256 count) view returns (uint256)',
  'function quoteToken(address token, uint256 count) view returns (uint256)',
  'function bundlePrice(uint256 unit, uint256 count) pure returns (uint256)',
  'function kindName(uint8 kind) view returns (string)',
  'function kindExists(uint8 kind) view returns (bool)',
  'event PacksBoughtOfKind(address indexed buyer, uint256 firstPackId, uint256 count, uint8 kind)',
  'error UnknownKind(uint8 kind)',
  'event PacksBought(address indexed buyer, uint256 firstPackId, uint256 count, address payToken, uint256 paid)',
  'event PackOpened(uint256 indexed packId, address indexed owner, uint256[5] cardIds)',
  'event PackRecommitted(uint256 indexed packId, uint64 revealBlock)',
  'event PacksGranted(address indexed to, uint256 firstPackId, uint256 count, uint8 kind)',
  'error BadCount()',
  'error WrongPayment()',
  'error TokenNotAccepted(address token)',
  'error NotOwner()',
  'error AlreadyOpened()',
  'error TooEarly(uint256 revealBlock)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
]);

export const craftingAbi = parseAbi([
  'function scrap(address player) view returns (uint256)',
  'function scrapValue(uint256 rarity) view returns (uint256)',
  'function craftCost(uint256 rarity) view returns (uint256)',
  'function scrapCards(uint256[] ids, uint256[] amounts)',
  'function craft(uint256 id)',
  'event ScrapGranted(address indexed player, uint256 amount)',
  'error StarterNotScrappable(uint256 id)',
  'error FoilNotCraftable(uint256 id)',
  'error NotEnoughScrap(uint256 have, uint256 need)',
  'error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId)',
]);

/** Daily quest payouts (Scrap and free packs), paid by the referee. */
export const questRewardsAbi = parseAbi([
  'function reward(address player, bytes32 claimId, uint256 scrap, uint8 packKind, uint256 packCount)',
  'function claimed(bytes32 claimId) view returns (bool)',
  'event Rewarded(bytes32 indexed claimId, address indexed player, uint256 scrap, uint8 packKind, uint256 packCount)',
  'error AlreadyClaimed(bytes32 claimId)',
  'error OverClaimCap()',
  'error OverDailyBudget()',
  'error NothingToPay()',
  'error UnknownKind(uint8 kind)',
]);

export const faucetTokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function drip()',
  'function lastDrip(address) view returns (uint256)',
  'function dripAmount() view returns (uint256)',
  'function mint(address to, uint256 amount)',
  'error Cooldown(uint256 readyAt)',
]);

/** Contract addresses served by the referee (`GET /v1/config` → contracts). */
export interface HubContracts {
  CardRegistry: `0x${string}`;
  StarterDecks: `0x${string}`;
  PackSale: `0x${string}`;
  Crafting: `0x${string}`;
  DeckRegistry: `0x${string}`;
  MatchSettlement: `0x${string}`;
  AgentRegistry: `0x${string}`;
  HumanRegistry: `0x${string}`;
  AgentLeague?: `0x${string}`;
  SeasonRewards: `0x${string}`;
  TestUSDC: `0x${string}`;
  TestFALL: `0x${string}`;
}

export const deckRegistryAbi = parseAbi([
  'function register(uint8 race, uint16[] ids) returns (bytes32 deckId)',
  'function getDeck(bytes32 deckId) view returns ((address owner, uint8 race, uint16 rarityPoints, uint8 legendaries, uint16[] cardIds))',
  'function decksOf(address owner) view returns (bytes32[])',
  'function isValidFor(bytes32 deckId, address player, bool ranked) view returns (bool)',
  'event DeckRegistered(bytes32 indexed deckId, address indexed owner, uint8 race, uint16 rarityPoints, bool rankedLegal)',
  'error BadSize(uint256 n)',
  'error NotSorted()',
  'error BadRace(uint8 race)',
  'error WrongRace(uint256 cardId)',
  'error TooManyCopies(uint256 cardId)',
  'error NotOwned(uint256 cardId, uint256 have, uint256 need)',
]);

export const matchSettlementAbi = parseAbi([
  'struct MatchResult { bytes32 matchId; address playerA; address playerB; address winner; bytes32 deckA; bytes32 deckB; uint8 mode; uint32 season; uint16 turns; bytes32 logHash; }',
  'function settle(MatchResult r, bytes sigA, bytes sigB, bytes refereeSig)',
  'function settleByReferee(MatchResult r, bytes winnerSig)',
  'function settled(bytes32 matchId) view returns (bool)',
  'function currentSeason() view returns (uint32)',
  'function startSeason(uint32 season)',
  'function stats(uint32 season, address player) view returns ((uint32 wins, uint32 losses, uint32 draws, uint32 rating))',
  'function expectedScore(uint256 ra, uint256 rb) view returns (uint256)',
  'event MatchSettled(bytes32 indexed matchId, address indexed winner, address indexed loser, uint8 mode, uint32 season, uint16 turns, bytes32 logHash, bool byReferee)',
  'event RatingChanged(uint32 indexed season, address indexed player, uint32 oldRating, uint32 newRating)',
  'error AlreadySettled(bytes32 matchId)', 'error BadPlayers()', 'error BadWinner()', 'error BadSignature(address signer)',
  'error WrongSeason(uint32 season)', 'error InvalidDeck(address player)', 'error Banned(address player)',
  'error NotHuman(address player)', 'error UnknownMode(uint8 mode)', 'error MissingRefereeSignature()',
]);

/** ERC-8004 Identity Registry (agents) + Forkfall extensions. */
export const agentRegistryAbi = parseAbi([
  'struct MetadataEntry { string metadataKey; bytes metadataValue; }',
  'function register(string agentURI) returns (uint256 agentId)',
  'function register(string agentURI, MetadataEntry[] metadata) returns (uint256 agentId)',
  'function registerWithWallet(string agentURI, uint256 expectedAgentId, address wallet, uint256 deadline, bytes signature) returns (uint256 agentId)',
  'function nextAgentId() view returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function unsetAgentWallet(uint256 agentId)',
  'function agentWalletDigest(uint256 agentId, address newWallet, address owner, uint256 deadline) view returns (bytes32)',
  'function burn(uint256 agentId)',
  'function isAgent(address who) view returns (bool)',
  'function agentOf(address wallet) view returns (uint256)',
  'function bannedFromRanked(address) view returns (bool)',
  'function maxAgentsPerOperator() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'error OperatorCapReached(address operator)', 'error NotAuthorized()', 'error ReservedKey()',
  'error SignatureExpired()', 'error BadWalletSignature()', 'error AgentIdTaken(uint256 expected, uint256 next)',
]);

export const humanRegistryAbi = parseAbi([
  'function verification(address) view returns (bytes32 method, uint64 verifiedAt, uint64 expiresAt)',
  'function isVerifiedHuman(address player) view returns (bool)',
  'function attest(address player, bytes32 method, uint64 expiresAt)',
  'function methodEnabled(bytes32) view returns (bool)',
]);

export const seasonRewardsAbi = parseAbi([
  'function seasons(uint32) view returns (bytes32 root, address token, uint64 claimDeadline)',
  'function claimed(uint32 season, address player) view returns (bool)',
  'function claim(uint32 season, uint256 amount, bytes32[] proof)',
  'function publishSeason(uint32 season, bytes32 root, address token, uint64 claimDeadline)',
  'error NoSeason(uint32 season)', 'error AlreadyClaimed()', 'error BadProof()', 'error ClaimClosed()',
]);

/** Agent League: prepaid entry fees, weekly pot, standings and payouts. */
export const agentLeagueAbi = parseAbi([
  'function entryFee() view returns (uint256)',
  'function potBps() view returns (uint16)',
  'function buybackBps() view returns (uint16)',
  'function currentWeek() view returns (uint32)',
  'function weekEndsAt(uint32 week) view returns (uint256)',
  'function balanceOf(address agent) view returns (uint256)',
  'function operatorOf(address agent) view returns (address)',
  'function canPair(address a, address b) view returns (bool ok, string reason)',
  'function pot(uint32 week) view returns (uint256)',
  'function paid(uint32 week) view returns (uint256)',
  'function payoutRoot(uint32 week) view returns (bytes32)',
  'function claimDeadline(uint32 week) view returns (uint64)',
  'function claimed(uint32 week, address agent) view returns (bool)',
  'function players(uint32 week) view returns (address[])',
  'function standing(uint32 week, address agent) view returns ((uint32 games, uint32 wins, uint32 losses, uint32 draws, uint32 opponents, uint32 rating))',
  'function deposit(uint256 amount)',
  'function depositFor(address agent, uint256 amount)',
  'function withdraw(address agent, uint256 amount)',
  'function fundPot(uint32 week, uint256 amount)',
  'function claim(uint32 week, address agent, uint256 amount, bytes32[] proof)',
  'function startMatch(bytes32 matchId, address a, address b)',
  'function cancelMatch(bytes32 matchId)',
  'function publishWeek(uint32 week, bytes32 root, uint64 deadline)',
  'function rollover(uint32 week)',
  'function sweep()',
  'error NotAgent(address who)', 'error SameOperator(address operator)', 'error Banned(address who)',
  'error InsufficientBalance(address agent, uint256 have, uint256 need)', 'error BadMatchState(bytes32 matchId)',
  'error WrongPlayers(bytes32 matchId)', 'error WeekNotOver(uint32 week)', 'error NotPublished(uint32 week)',
  'error AlreadyClaimed()', 'error BadProof()', 'error ClaimClosed()', 'error ExceedsPot(uint32 week)', 'error NotAgentOrOperator()',
]);
