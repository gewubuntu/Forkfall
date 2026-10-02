import { card, PREDICTION_LABELS, type Faction, type GameEvent, type Keyword, type Race } from '@forkfall/engine';

export const RACE_COLOR: Record<Faction, string> = {
  agents: 'var(--agents)', prophets: 'var(--prophets)', brokers: 'var(--brokers)', degens: 'var(--degens)', neutral: 'var(--neutral)',
};

export const RACE_INFO: Record<Race, { name: string; chain: 'Base' | 'Robinhood Chain'; sprite: number; style: string }> = {
  agents: { name: 'Agents', chain: 'Base', sprite: 8, style: 'Scripted combos and Drone floods' },
  prophets: { name: 'Prophets', chain: 'Base', sprite: 16, style: 'Face-down predictions and reads' },
  brokers: { name: 'Brokers', chain: 'Robinhood Chain', sprite: 24, style: 'Slow start, compounding late game' },
  degens: { name: 'Degens', chain: 'Robinhood Chain', sprite: 32, style: 'Cheap swarms and burst damage' },
};

export const KEYWORD_LABEL: Partial<Record<Keyword, string>> = {
  guard: 'Guard', rush: 'Rush', hold: 'Hold', swarm: 'Swarm', firewall: 'Firewall', ape: 'Ape',
};

export const KEYWORD_HELP: Partial<Record<Keyword, string>> = {
  guard: 'Enemies must attack Guard units first.',
  rush: 'Can attack the turn it is played.',
  hold: 'Grows +1/+1 each turn it sat through without attacking.',
  swarm: '+1 attack for each other friendly Swarm unit.',
  firewall: 'Deals 1 damage to every enemy unit that is summoned.',
  ape: 'Can be played for 2 less Gas with a random downside.',
};

export const raceName = (r: Race) => RACE_INFO[r].name;

/** One human-readable log line per event, from `viewer`'s point of view. */
export function describeEvent(e: GameEvent, viewer: number | null, races: [Race, Race]): string | null {
  const who = (s: number) => (viewer === null ? raceName(races[s]) : s === viewer ? 'You' : 'Opponent');
  const whose = (s: number) => (viewer === null ? `${raceName(races[s])}'s` : s === viewer ? 'Your' : "Opponent's");
  switch (e.t) {
    case 'turnStart': return `Turn ${e.turn} · ${who(e.seat)}`;
    case 'draw': return `You drew ${card(e.cardId).name}`;
    case 'play': return `${who(e.seat)} played ${card(e.cardId).name}${e.ape ? ' (aped in)' : ''}`;
    case 'predictionMade': return `You predicted: ${PREDICTION_LABELS[e.condition]}`;
    case 'predictionResolved': return `${whose(e.seat)} prediction "${PREDICTION_LABELS[e.condition]}" ${e.hit ? 'came true' : 'backfired'}`;
    case 'attack': return `${who(e.seat)} attacked ${e.target === 'treasury' ? 'the Treasury' : 'a unit'}`;
    case 'damage': return e.uid === 'treasury' ? `${whose(e.seat)} Treasury −${e.n}` : null;
    case 'death': return `${card(e.cardId).name} was destroyed`;
    case 'hold': return `${whose(e.seat)} unit Held: +1/+1`;
    case 'automate': return `${whose(e.seat)} automation fired`;
    case 'apeDownside': return `Ape downside: ${e.kind === 'treasury' ? 'lost 2 Treasury' : e.kind === 'discard' ? 'discarded a card' : 'unit came in fragile'}`;
    case 'fatigue': return `${who(e.seat)} took ${e.n} fatigue`;
    case 'create': return `${card(e.cardId).name} added to your hand`;
    case 'burn': return `${card(e.cardId).name} burned (hand full)`;
    case 'gameOver': return `Game over (${e.reason})`;
    default: return null;
  }
}
