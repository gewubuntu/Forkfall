import { card, hasCard, MAX_COPIES } from './cards.ts';
import type { Race } from './types.ts';

/**
 * Deck codes: a deck as a short string to paste into a post or a chat, like `FFAQEC…`. Anyone can open it in the
 * deck builder; it carries the race and card list only, never an owner, so it works for any wallet.
 *
 * Layout (then base64url, prefixed `FF`): version byte, race byte (DeckRegistry's codes), then for each distinct
 * card in ascending id order a varint of `(id - previous id) << 1 | (copies - 1)`, then a 16-bit checksum so a
 * mistyped or truncated code is refused instead of opening the wrong deck. A 30-card deck is about 30 characters.
 */
export const DECK_CODE_VERSION = 1;
const PREFIX = 'FF';
const RACE_CODE: Record<Race, number> = { agents: 1, prophets: 2, brokers: 3, degens: 4 };
const RACE_OF = new Map(Object.entries(RACE_CODE).map(([r, n]) => [n, r as Race]));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export class DeckCodeError extends Error {}

export function encodeDeck(race: Race, cards: number[]): string {
  if (!(race in RACE_CODE)) throw new DeckCodeError(`unknown race ${race}`);
  const counts = new Map<number, number>();
  for (const id of cards) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new DeckCodeError(`bad card id ${id}`);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const bytes = [DECK_CODE_VERSION, RACE_CODE[race]];
  let prev = 0;
  for (const id of [...counts.keys()].sort((a, b) => a - b)) {
    const n = counts.get(id)!;
    if (n > MAX_COPIES) throw new DeckCodeError(`${n} copies of card ${id}: a deck holds at most ${MAX_COPIES}`);
    varint(bytes, (id - prev) * 2 + (n - 1));
    prev = id;
  }
  const sum = checksum(bytes);
  bytes.push(sum >> 8, sum & 0xff);
  return PREFIX + toBase64Url(bytes);
}

/** The race and card list (ascending ids) of a deck code. Finds the code inside pasted text, e.g. a whole post. */
export function decodeDeck(text: string): { race: Race; cards: number[] } {
  // Every run starting with FF is a candidate ("OFFICIAL" holds one too); the first that decodes wins.
  const candidates = [...text.matchAll(/FF[A-Za-z0-9_-]{4,}/g)].map((m) => m[0]);
  if (!candidates.length) throw new DeckCodeError('that isn’t a Forkfall deck code (they start with FF)');
  let error: unknown;
  for (const code of candidates) {
    try { return decodeOne(code); } catch (e) { error = e; }
  }
  throw error;
}

function decodeOne(code: string): { race: Race; cards: number[] } {
  const bytes = fromBase64Url(code.slice(PREFIX.length));
  if (!bytes || bytes.length < 4) throw new DeckCodeError('that deck code is damaged: check it was copied whole');
  const body = bytes.slice(0, -2);
  if (checksum(body) !== (bytes[bytes.length - 2] << 8 | bytes[bytes.length - 1])) {
    throw new DeckCodeError('that deck code is damaged: check it was copied whole');
  }
  if (body[0] !== DECK_CODE_VERSION) throw new DeckCodeError('that deck code is from a newer version of Forkfall');
  const race = RACE_OF.get(body[1]);
  if (!race) throw new DeckCodeError('that deck code names an unknown race');
  const cards: number[] = [];
  let id = 0;
  for (let i = 2; i < body.length;) {
    let v = 0;
    let shift = 1;
    for (;;) {
      if (i >= body.length) throw new DeckCodeError('that deck code is damaged: check it was copied whole');
      const b = body[i++];
      v += (b & 0x7f) * shift;
      shift *= 128;
      if (!(b & 0x80)) break;
      if (shift > 2 ** 35) throw new DeckCodeError('that deck code is damaged: check it was copied whole');
    }
    const delta = Math.floor(v / 2);
    if (delta === 0) throw new DeckCodeError('that deck code is damaged: check it was copied whole');
    id += delta;
    const c = hasCard(id) ? card(id) : null;
    if (!c || !c.collectible) throw new DeckCodeError(`that deck code holds a card this version doesn’t know (#${id})`);
    if (c.faction !== race && c.faction !== 'neutral') throw new DeckCodeError(`that deck code puts ${c.name} in a ${race} deck`);
    for (let n = (v % 2) + 1; n > 0; n--) cards.push(id);
  }
  return { race, cards };
}

function varint(out: number[], v: number) {
  while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}

/** Fletcher-16. */
function checksum(bytes: number[]): number {
  let a = 0;
  let b = 0;
  for (const x of bytes) { a = (a + x) % 255; b = (b + a) % 255; }
  return (b << 8) | a;
}

function toBase64Url(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil(((Math.min(3, bytes.length - i)) * 8) / 6);
    for (let k = 0; k < chars; k++) s += B64[(n >> (18 - 6 * k)) & 63];
  }
  return s;
}

function fromBase64Url(s: string): number[] | null {
  if (s.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const v = k < chunk.length ? B64.indexOf(chunk[k]) : 0;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    const bytes = chunk.length - 1; // 2 chars → 1 byte, 3 → 2, 4 → 3
    for (let k = 0; k < bytes; k++) out.push((n >> (16 - 8 * k)) & 0xff);
  }
  return out;
}
