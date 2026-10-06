import { cosmetic, lessonById, NO_COSMETICS, unlockedCosmetics, type Equipped } from '@forkfall/engine';
import { join } from 'node:path';
import type { Address } from 'viem';
import { readJsonOrSetAside, writeFileAtomic } from './state.ts';

export interface Profile extends Equipped {
  /** Finished the basics lesson (the tutorial). */
  tutorial: boolean;
  /** Every lesson finished: 'basics', 'prophets', 'brokers', 'degens'. */
  lessons: string[];
}

/** Where profiles (tutorial done, equipped cosmetics) are kept: apps/server/data/profiles/<chainId>.json. */
export const profilesFile = (root: string, chainId: number) => join(root, 'apps/server/data/profiles', `${chainId}.json`);

/**
 * Player profiles: lessons finished and equipped cosmetics. Cosmetics are checked against on-chain card
 * balances before they can be equipped (lessons are self-reported: they unlock only the Graduate and Scholar titles).
 */
export class Profiles {
  private data: Record<string, Profile>;
  /** Where an unusable profiles file was moved at startup (null if it loaded). */
  readonly setAside: string | null;
  constructor(private file?: string, private owned?: (a: Address) => Promise<Map<number, number> | null>) {
    ({ data: this.data, setAside: this.setAside } = file ? readJsonOrSetAside<Record<string, Profile>>(file, () => ({})) : { data: {}, setAside: null });
  }

  get(address: string): Profile {
    const p = this.data[address.toLowerCase()];
    if (!p) return { ...NO_COSMETICS, tutorial: false, lessons: [] };
    // Profiles saved before lessons existed only knew about the tutorial.
    const lessons = p.lessons ?? (p.tutorial ? ['basics'] : []);
    return { ...p, lessons, tutorial: lessons.includes('basics') };
  }

  equipped(address: string): Equipped {
    const p = this.get(address);
    return { title: p.title, cardBack: p.cardBack, badge: p.badge };
  }

  /** Season pass cosmetics earned (the referee's quest tracker): set once both exist. */
  passUnlocked?: (address: string) => string[];

  async unlocked(address: Address): Promise<string[]> {
    const counts = (await this.owned?.(address)) ?? new Map<number, number>();
    return [...unlockedCosmetics((id) => counts.get(id) ?? 0, this.get(address).lessons), ...(this.passUnlocked?.(address) ?? [])];
  }

  /** Records a finished lesson (the basics tutorial by default). Throws for an unknown lesson. */
  completeLesson(address: Address, lesson = 'basics'): Profile {
    if (!lessonById(lesson)) throw new Error(`unknown lesson "${lesson}"`);
    const p = this.get(address);
    const lessons = p.lessons.includes(lesson) ? p.lessons : [...p.lessons, lesson];
    return this.save(address, { ...p, lessons, tutorial: lessons.includes('basics') });
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
    if (this.file) writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
    return p;
  }
}
