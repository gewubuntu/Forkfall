import { card, CARDS, RACES, SET_NAME, setOf, starterDeck, type CardDef } from '@forkfall/engine';
import { cardDataUri } from './frame.ts';

/** CardRegistry: token id `n` is card n; `STARTER_OFFSET + n` is its soulbound starter-deck copy; `FOIL_OFFSET + n` its foil. */
export const STARTER_OFFSET = 10_000;
export const FOIL_OFFSET = 20_000;

/** Base card id and edition for any token id. */
export function splitTokenId(tokenId: number): { baseId: number; starter: boolean; foil: boolean } {
  if (tokenId >= FOIL_OFFSET) return { baseId: tokenId - FOIL_OFFSET, starter: false, foil: true };
  if (tokenId >= STARTER_OFFSET) return { baseId: tokenId - STARTER_OFFSET, starter: true, foil: false };
  return { baseId: tokenId, starter: false, foil: false };
}

const RACE = { agents: 'Agents', prophets: 'Prophets', brokers: 'Brokers', degens: 'Degens', neutral: 'Neutral' } as const;
const CHAIN = { base: 'Base', robinhood: 'Robinhood Chain', any: 'Any' } as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** ERC-1155 `{id}` substitution: lowercase hex, zero-padded to 64 characters, no 0x prefix. */
export function erc1155IdHex(tokenId: number | bigint): string {
  return BigInt(tokenId).toString(16).padStart(64, '0');
}

/** Token ids with metadata: every collectible card, its foil, plus soulbound copies of the cards that appear in a starter deck. */
export function tokenIds(): number[] {
  const base = CARDS.filter((c) => c.collectible);
  const inStarters = new Set(RACES.flatMap((r) => starterDeck(r)));
  return [...base.map((c) => c.id), ...base.filter((c) => inStarters.has(c.id)).map((c) => c.id + STARTER_OFFSET), ...base.map((c) => c.id + FOIL_OFFSET)];
}

export function parseTokenId(raw: string): number | null {
  const s = raw.replace(/\.json$|\.svg$/, '');
  const n = /^[0-9a-f]{64}$/i.test(s) ? Number(BigInt('0x' + s)) : /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n)) return null;
  return tokenIds().includes(n) ? n : null;
}

export interface MetadataOptions {
  /** Where images are served ("https://host/metadata/images"); omitted = image embedded as a data URI (self-contained, IPFS-ready). */
  imageBase?: string;
  /** Web app origin for external_url ("https://forkfall.example"). */
  appUrl?: string;
}

/** OpenSea-compatible ERC-1155 metadata (name, description, image, attributes). */
export function cardMetadata(tokenId: number, opts: MetadataOptions = {}) {
  const { baseId, starter, foil } = splitTokenId(tokenId);
  const c: CardDef = card(baseId);
  const attrs: { trait_type: string; value: string | number; display_type?: string }[] = [
    { trait_type: 'Race', value: RACE[c.faction] },
    { trait_type: 'Chain of origin', value: CHAIN[c.chain] },
    { trait_type: 'Type', value: cap(c.type) },
    { trait_type: 'Rarity', value: cap(c.rarity) },
    { trait_type: 'Gas cost', value: c.cost, display_type: 'number' },
  ];
  if (c.type === 'unit') attrs.push({ trait_type: 'Attack', value: c.attack ?? 0, display_type: 'number' }, { trait_type: 'Health', value: c.health ?? 0, display_type: 'number' });
  for (const k of c.keywords) attrs.push({ trait_type: 'Keyword', value: cap(k) });
  attrs.push({ trait_type: 'Edition', value: starter ? 'Starter (soulbound)' : foil ? 'Foil' : 'Tradeable' }, { trait_type: 'Set', value: setOf(c) === 'core' ? 'Set 1 (prototype)' : `${SET_NAME[setOf(c)]} (collab)` });
  const description = [
    c.text,
    starter
      ? `Soulbound starter-deck copy of ${c.name}: plays exactly like the tradeable card and can never be transferred.`
      : foil
      ? `Foil ${c.name}, found in packs (about 1 card in 15). Cosmetic: plays exactly like ${c.name}. Tradeable; scraps for 4×; can't be crafted.`
      : setOf(c) === 'poncho'
        ? `${cap(c.rarity)} ${c.type} from the Poncho collab set, starring Poncho, the cutest cat on Base (@ponchobase). Neutral: playable in any race's deck.`
        : `${cap(c.rarity)} ${c.type} from the ${RACE[c.faction]}.`,
    'Forkfall is a testnet-alpha trading card game where humans and AI agents share one ladder. Prototype art.',
  ].filter(Boolean).join('\n\n');
  return {
    name: starter ? `${c.name} (Starter)` : foil ? `${c.name} (Foil)` : c.name,
    description,
    image: opts.imageBase ? `${opts.imageBase}/${tokenId}.svg` : cardDataUri(baseId, { starter, foil }),
    ...(opts.appUrl ? { external_url: `${opts.appUrl}/collection` } : {}),
    background_color: '0a0c12',
    decimals: 0,
    attributes: attrs,
    properties: {
      cardId: c.id, slug: c.slug, faction: c.faction, chain: c.chain, type: c.type, rarity: c.rarity,
      set: setOf(c), cost: c.cost, attack: c.attack ?? null, health: c.health ?? null, keywords: c.keywords, starter, soulbound: starter, foil,
    },
  };
}

/** ERC-7572 contract-level metadata (CardRegistry.contractURI). */
export function collectionMetadata(opts: MetadataOptions & { image?: string } = {}) {
  return {
    name: 'Forkfall Cards (testnet)',
    symbol: 'FFCARD',
    description: 'Cards for Forkfall, the on-chain trading card game where humans and AI agents play on the same ladder. Testnet alpha: no real value. Token n is card n; 10000 + n is its soulbound starter copy; 20000 + n is its foil.',
    image: opts.image ?? cardDataUri(8),
    ...(opts.appUrl ? { external_link: opts.appUrl } : {}),
  };
}
