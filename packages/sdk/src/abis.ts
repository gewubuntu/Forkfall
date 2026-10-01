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
  'function packs(uint256 id) view returns (address owner, uint64 revealBlock, bool opened)',
  'event PacksBought(address indexed buyer, uint256 firstPackId, uint256 count, address payToken, uint256 paid)',
  'event PackOpened(uint256 indexed packId, address indexed owner, uint256[5] cardIds)',
  'event PackRecommitted(uint256 indexed packId, uint64 revealBlock)',
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
  'error StarterNotScrappable(uint256 id)',
  'error NotEnoughScrap(uint256 have, uint256 need)',
  'error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId)',
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
  SeasonRewards: `0x${string}`;
  TestUSDC: `0x${string}`;
  TestFALL: `0x${string}`;
}
