import { cosmetic, NO_COSMETICS, unlockedCosmetics, type Equipped } from '@forkfall/engine';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Address } from 'viem';

export interface Profile extends Equipped { tutorial: boolean }

/** Where profiles (tutorial done, equipped cosmetics) are kept: apps/server/data/profiles/<chainId>.json. */
export const profilesFile = (root: string, chainId: number) => join(root, 'apps/server/data/profiles', `${chainId}.json`);

/**
 * Player profiles: tutorial completion and equipped cosmetics. Cosmetics are checked against on-chain card
 * balances before they can be equipped (the tutorial is self-reported: it unlocks only the Graduate title).
 */
export class Profiles {
  private data: Record<string, Profile>;
  constructor(private file?: string, private owned?: (a: Address) => Promise<Map<number, number> | null>) {
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  get(address: string): Profile {
    return this.data[address.toLowerCase()] ?? { ...NO_COSMETICS, tutorial: false };
  }

  equipped(address: string): Equipped {
    const p = this.get(address);
    return { title: p.title, cardBack: p.cardBack, badge: p.badge };
  }

  async unlocked(address: Address): Promise<string[]> {
    const counts = (await this.owned?.(address)) ?? new Map<number, number>();
    return [...unlockedCosmetics((id) => counts.get(id) ?? 0, this.get(address).tutorial)];
  }

  completeTutorial(address: Address): Profile {
    return this.save(address, { ...this.get(address), tutorial: true });
  }

  /** Equip one cosmetic per kind (null clears). Throws if a cosmetic is unknown, of the wrong kind or still locked. */
  async equip(address: Address, want: Partial<Equipped>): Promise<Profile> {
    const unlocked = new Set(await this.unlocked(address));
    const next = { ...this.get(address) };
    for (const kind of ['title', 'cardBack', 'badge'] as const) {
      if (!(kind in want)) continue;
      const id = want[kind] ?? null;
      if (id !== null) {
        const c = cosmetic(id);
        if (!c || c.kind !== kind) throw new Error(`unknown ${kind} "${id}"`);
        if (!unlocked.has(id)) throw new Error(`"${c.name}" is locked: ${c.description}`);
      }
      next[kind] = id;
    }
    return this.save(address, next);
  }

  private save(address: string, p: Profile): Profile {
    this.data[address.toLowerCase()] = p;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }
    return p;
  }
}
