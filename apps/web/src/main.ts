import {
  card, PREDICTION_LABELS, PREDICTION_TIERS, RACE_CHAIN, RACES, BEATS,
  type Action, type GameEvent, type PredictionCondition, type Race, type UnitState,
} from '@forkfall/engine';
import { ForkfallClient, type MatchSnapshot } from '@forkfall/sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { spriteSvg } from './art.ts';

// ─── Burner testnet identity ─────────────────────────────────────
const KEY = 'forkfall.burnerKey';
let pk = (localStorage.getItem(KEY) as Hex | null) ?? null;
if (!pk) { pk = generatePrivateKey(); localStorage.setItem(KEY, pk); }
const client = new ForkfallClient(import.meta.env.VITE_SERVER_URL ?? location.origin, privateKeyToAccount(pk));

const RACE_INFO: Record<Race, { blurb: string; color: string }> = {
  agents: { blurb: 'Automate · Deploy · Compute', color: 'var(--agents)' },
  prophets: { blurb: 'Foresee · Odds · Backfire', color: 'var(--prophets)' },
  brokers: { blurb: 'Hold · Dividend · Portfolio', color: 'var(--brokers)' },
  degens: { blurb: 'Swarm · Pump · Rug · Ape', color: 'var(--degens)' },
};

interface UI {
  screen: 'lobby' | 'match';
  race: Race;
  mode: 'casual' | 'ranked' | 'human';
  deckId: string;
  queued: boolean;
  matchId?: Hex;
  snap?: MatchSnapshot;
  selected?: { kind: 'hand' | 'unit'; uid: number };
  pendingPlay?: { uid: number; ape?: boolean };
  modal?: 'ape' | 'prediction';
  hint: string;
  log: string[];
  eventCursor: number;
  error?: string;
  resultSigned?: boolean;
  settlement?: unknown;
  matches: { matchId: Hex; mode: string; phase: string; turn: number; players: { address: string; race: Race; agent: boolean }[] }[];
}

const ui: UI = { screen: 'lobby', race: 'agents', mode: 'casual', deckId: '', queued: false, hint: '', log: [], eventCursor: 0, matches: [] };
const app = document.getElementById('app')!;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ─── Card rendering ──────────────────────────────────────────────
function cardHtml(cardId: number, opts: { uid?: number; unit?: UnitState; classes?: string; swarmBonus?: number; ready?: boolean; cost?: number } = {}) {
  const c = card(cardId);
  const race = c.faction === 'neutral' ? 'var(--neutral)' : RACE_INFO[c.faction].color;
  const u = opts.unit;
  const atk = u ? u.attack + (opts.swarmBonus ?? 0) : c.attack;
  const hp = u ? u.health : c.health;
  const kws = (u?.keywords ?? c.keywords).filter((k) => !['noBackfire', 'predictionBonus'].includes(k));
  const chain = c.chain === 'base' ? 'BASE' : c.chain === 'robinhood' ? 'RH' : '';
  return `<div class="card r-${c.rarity} ${u ? 'unit-card' : ''} ${opts.classes ?? ''}" style="--rc:${race}" data-uid="${opts.uid ?? ''}" title="${escapeHtml(c.name + ' — ' + c.text)}">
    ${u ? '' : `<div class="cost">${opts.cost ?? c.cost}</div>`}
    <div class="chain">${chain}</div>
    <img class="art" src="${spriteSvg(cardId)}" alt="" />
    <div class="name">${escapeHtml(c.name)}</div>
    ${u ? `<div class="kw">${kws.join(' · ')}</div>` : `<div class="text">${escapeHtml(c.text)}</div>`}
    ${c.type === 'unit' ? `<div class="stats"><span class="atk">⚔ ${atk}</span><span class="hp">♥ ${hp}</span></div>` : `<div class="kw">${c.type}</div>`}
    ${opts.ready ? '<div class="ready">READY</div>' : ''}
  </div>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// ─── Lobby ───────────────────────────────────────────────────────
function renderLobby() {
  app.innerHTML = `
    <h1>Forkfall</h1>
    <p class="muted">Fast on-chain card duels. Humans and agents on one ladder, one protocol. Drain the enemy Treasury from 25 to 0.</p>
    <div class="grid2">
      <div class="panel">
        <h2>Choose your race</h2>
        <div class="races">
          ${RACES.map((r) => `<button class="race ${ui.race === r ? 'sel' : ''}" data-race="${r}" style="--rc:${RACE_INFO[r].color}">
              <b>${r[0].toUpperCase() + r.slice(1)}</b><small>${RACE_CHAIN[r] === 'base' ? 'Base' : 'Robinhood Chain'} · ${RACE_INFO[r].blurb}<br/>beats ${BEATS[r]}</small>
            </button>`).join('')}
        </div>
        <div class="row" style="margin-top:14px">
          <button class="primary" id="practice">Practice vs bot</button>
          <select id="mode">
            ${['casual', 'ranked', 'human'].map((m) => `<option ${ui.mode === m ? 'selected' : ''} value="${m}">${m === 'human' ? 'Human queue' : m}</option>`).join('')}
          </select>
          <button id="queue">${ui.queued ? 'Leave queue' : 'Find opponent'}</button>
        </div>
        ${ui.mode !== 'casual' ? `<div class="row" style="margin-top:8px"><input id="deckId" placeholder="deckId from DeckRegistry (0x…)" style="flex:1" value="${escapeHtml(ui.deckId)}" /></div>
          <p class="muted" style="font-size:12px">Ranked needs your deck registered on-chain: <span class="mono">forge script script/Play.s.sol --sig "registerStarterDeck(uint8)" ${RACES.indexOf(ui.race) + 1} …</span></p>` : ''}
        ${ui.queued ? '<p class="hint">Searching for an opponent…</p>' : ''}
        ${ui.error ? `<p class="hint" style="color:var(--bad)">${escapeHtml(ui.error)}</p>` : ''}
        <p class="muted mono" style="margin-top:14px">You: ${client.address} <span class="badge">burner</span></p>
      </div>
      <div class="panel">
        <h2>Live & recent matches</h2>
        <div class="list">
          ${ui.matches.length ? ui.matches.map((m) => `<div class="item"><span>${m.players.map((p) => `${p.race}${p.agent ? ' <span class="badge agent">AGENT</span>' : ''}`).join(' vs ')}</span><span class="muted">${m.mode} · ${m.phase} · t${m.turn}</span><button data-watch="${m.matchId}">Watch</button></div>`).join('') : '<span class="muted">No matches yet.</span>'}
        </div>
        <h2 style="margin-top:16px">Starter deck preview</h2>
        <div class="row">${[...new Set(starterPreview(ui.race))].slice(0, 6).map((id) => cardHtml(id)).join('')}</div>
      </div>
    </div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-race]').forEach((b) => (b.onclick = () => { ui.race = b.dataset.race as Race; render(); }));
  (app.querySelector('#mode') as HTMLSelectElement).onchange = (e) => { ui.mode = (e.target as HTMLSelectElement).value as UI['mode']; render(); };
  const deckInput = app.querySelector('#deckId') as HTMLInputElement | null;
  if (deckInput) deckInput.oninput = () => { ui.deckId = deckInput.value.trim(); };
  (app.querySelector('#practice') as HTMLButtonElement).onclick = () => act(async () => enterMatch(await client.practice({ race: ui.race })));
  (app.querySelector('#queue') as HTMLButtonElement).onclick = () => act(async () => {
    if (ui.queued) { await client.leaveQueue(); ui.queued = false; return; }
    const r = await client.queue({ mode: ui.mode, race: ui.race, deckId: ui.mode !== 'casual' && ui.deckId ? (ui.deckId as Hex) : undefined });
    if (r.matchId) return enterMatch(r.matchId);
    ui.queued = true;
  });
  app.querySelectorAll<HTMLButtonElement>('[data-watch]').forEach((b) => (b.onclick = () => enterMatch(b.dataset.watch as Hex)));
}

function starterPreview(r: Race) {
  return Array.from({ length: 40 }, (_, i) => i + 1).filter((id) => card(id).faction === r && card(id).rarity !== 'legendary');
}

async function enterMatch(id: Hex) {
  Object.assign(ui, { screen: 'match', matchId: id, snap: undefined, log: [], eventCursor: 0, selected: undefined, resultSigned: false, settlement: undefined, queued: false });
  await refresh(true);
}

// ─── Match ───────────────────────────────────────────────────────
function renderMatch() {
  const s = ui.snap;
  if (!s || !s.view) {
    app.innerHTML = `<div class="panel">Waiting for both players to reveal their seed… <button id="back">Back</button></div>`;
    (app.querySelector('#back') as HTMLButtonElement).onclick = backToLobby;
    return;
  }
  const v = s.view;
  const me = s.seat ?? 0;
  const op = me === 0 ? 1 : 0;
  const myTurn = s.phase === 'active' && v.active === s.seat;
  const legal = s.legalActions;
  const sel = ui.selected;
  const targetsFor = (pred: (a: Action) => boolean) => legal.filter(pred);
  const selActs = sel ? targetsFor((a) => (sel.kind === 'hand' ? a.type === 'play' && a.uid === sel.uid : a.type === 'attack' && a.attacker === sel.uid)) : [];
  const targetSet = new Set(selActs.map((a) => (a.type === 'play' ? a.target : a.type === 'attack' ? a.target : undefined)));
  const clockLeft = s.clock ? Math.max(0, Math.round((s.clock.turnEndsAt - Date.now()) / 1000)) : 0;
  const bank = s.clock ? Math.round(s.clock.bank[v.active] / 1000) : 0;

  const side = (seat: 0 | 1) => {
    const p = v.players[seat];
    const info = s.players[seat];
    const swarm = p.board.filter((u) => u.keywords.includes('swarm')).length;
    const isMe = seat === me && s.seat !== null;
    const canAttackUnits = new Set(isMe && myTurn ? legal.filter((a) => a.type === 'attack').map((a) => (a as { attacker: number }).attacker) : []);
    return `<div class="side ${isMe ? 'me' : ''}">
      <div class="hud">
        <span class="treasury ${!isMe && targetSet.has('treasury') ? 'targetable' : ''}" data-treasury="${seat}">🏦 ${p.treasury}</span>
        <span>${info.race} ${info.agent ? '<span class="badge agent">AGENT</span>' : ''} <span class="muted mono">${short(info.address)}</span></span>
        <span class="gas">${Array.from({ length: 10 }, (_, i) => `<i class="${i < p.gas ? 'on' : ''}" style="${i >= p.maxGas ? 'opacity:.25' : ''}"></i>`).join('')}</span>
        <span class="pill">Gas ${p.gas}/${p.maxGas}</span>
        <span class="pill">Deck ${p.deckCount}</span>
        <span class="pill">Hand ${p.handCount}</span>
        ${p.assets.map((a) => `<span class="pill" title="${escapeHtml(card(a.cardId).text)}">Asset: ${card(a.cardId).name}</span>`).join('')}
        ${p.predictions.map((x) => ('hidden' in x ? `<span class="pill">🔮 face-down prediction</span>` : `<span class="pill" title="${PREDICTION_LABELS[x.condition]}">🔮 ${card(x.cardId).name}: ${x.condition} (tier ${PREDICTION_TIERS[x.condition]})</span>`)).join('')}
        ${p.automationsQueued ? `<span class="pill">⚙ ${p.automationsQueued} automated</span>` : ''}
        ${p.discount ? `<span class="pill">Compute −${p.discount}</span>` : ''}
      </div>
      <div class="lane ${p.board.length ? '' : 'empty'}">
        ${p.board.map((u) => cardHtml(u.cardId, {
          uid: u.uid, unit: u, swarmBonus: u.keywords.includes('swarm') ? swarm - 1 : 0,
          ready: canAttackUnits.has(u.uid),
          classes: `${sel?.uid === u.uid ? 'sel' : ''} ${targetSet.has(u.uid) ? 'target' : ''}`,
        })).join('')}
      </div>
    </div>`;
  };

  const outcome = s.phase === 'ended'
    ? (v.winner === 'draw' ? 'Draw' : v.winner === s.seat ? 'Victory' : s.seat === null ? `Seat ${v.winner} wins` : 'Defeat')
    : '';

  app.innerHTML = `
    <div class="center" style="margin-bottom:10px">
      <div class="row"><button id="back">← Lobby</button><span class="pill">${s.mode}</span><span class="pill">Turn ${v.turn}</span>
        ${s.phase === 'active' ? `<span class="pill">${myTurn ? 'Your turn' : s.seat === null ? `Seat ${v.active} to move` : "Opponent's turn"} · <span id="clock">${clockLeft}s + bank ${bank}s</span></span>` : ''}
      </div>
      <div class="row">${myTurn ? '<button class="primary" id="end">End turn</button>' : ''}${s.phase === 'active' && s.seat !== null ? '<button id="concede">Concede</button>' : ''}</div>
    </div>
    <div class="board">
      ${side(op as 0 | 1)}
      <div class="hint">${escapeHtml(ui.hint)}</div>
      ${side(me as 0 | 1)}
    </div>
    ${s.seat !== null ? `<div class="hand">${v.hand.map((h) => {
      const playable = legal.some((a) => a.type === 'play' && a.uid === h.uid);
      const cost = Math.max(0, card(h.cardId).cost - v.players[me].discount);
      return cardHtml(h.cardId, { uid: h.uid, cost, classes: `${sel?.uid === h.uid ? 'sel' : ''} ${myTurn && !playable ? 'dim' : ''}` });
    }).join('')}</div>` : ''}
    <div class="grid2" style="margin-top:12px">
      <div class="panel"><h2>Match log</h2><div class="log">${ui.log.slice(-80).reverse().map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div></div>
      <div class="panel"><h2>${outcome || 'Protocol'}</h2>
        ${s.phase === 'ended' ? `
          <p>${ui.resultSigned ? 'Result co-signed (EIP-712).' : 'Signing result…'} Settle on-chain with Foundry:</p>
          <pre>forge script script/Play.s.sol --sig "settle(string)" settlements/${s.matchId}.json \\
  --rpc-url base_sepolia --broadcast --private-key $PK</pre>
          ${ui.settlement ? `<details><summary class="muted">settlement JSON</summary><pre>${escapeHtml(JSON.stringify(ui.settlement, null, 2))}</pre></details>` : '<p class="muted">Waiting for both signatures…</p>'}`
        : `<p class="muted mono">match ${short(s.matchId)} · seq ${s.seq} · log head ${short(s.head)}</p>
           <p class="muted" style="font-size:13px">Every move is EIP-712-signed by your key and chained into the log hash. Click a card to play it; click a READY unit, then a target, to attack.</p>`}
      </div>
    </div>
    ${ui.modal ? modalHtml() : ''}`;

  (app.querySelector('#back') as HTMLButtonElement).onclick = backToLobby;
  const end = app.querySelector('#end') as HTMLButtonElement | null;
  if (end) end.onclick = () => send({ type: 'endTurn' });
  const concede = app.querySelector('#concede') as HTMLButtonElement | null;
  if (concede) concede.onclick = () => confirm('Concede this match?') && send({ type: 'concede' });

  app.querySelectorAll<HTMLElement>('.card[data-uid]').forEach((el) => (el.onclick = () => onCardClick(Number(el.dataset.uid))));
  app.querySelectorAll<HTMLElement>('[data-treasury]').forEach((el) => (el.onclick = () => onTreasuryClick(Number(el.dataset.treasury))));
  app.querySelectorAll<HTMLElement>('[data-cond]').forEach((el) => (el.onclick = () => {
    const p = ui.pendingPlay!;
    ui.modal = undefined;
    send({ type: 'play', uid: p.uid, condition: el.dataset.cond as PredictionCondition, ...(p.ape ? { ape: true } : {}) });
  }));
  app.querySelectorAll<HTMLElement>('[data-ape]').forEach((el) => (el.onclick = () => {
    ui.modal = undefined;
    continuePlay(ui.pendingPlay!.uid, el.dataset.ape === '1');
  }));
  const cancel = app.querySelector('#cancel') as HTMLButtonElement | null;
  if (cancel) cancel.onclick = () => { ui.modal = undefined; ui.pendingPlay = undefined; render(); };
}

function modalHtml() {
  const s = ui.snap!;
  const p = ui.pendingPlay!;
  if (ui.modal === 'ape') {
    const c = card(s.view!.hand.find((h) => h.uid === p.uid)!.cardId);
    return `<div class="modal-bg"><div class="modal"><h2>Ape in?</h2>
      <p class="muted">Ape plays ${c.name} for 2 less Gas with a random downside (lose 2 Treasury, discard a random card, or the unit comes in fragile).</p>
      <button class="opt" data-ape="0">Play normally <span>${c.cost} Gas</span></button>
      <button class="opt" data-ape="1">Ape in 🦍 <span>${Math.max(0, c.cost - 2)} Gas</span></button>
      <button id="cancel">Cancel</button></div></div>`;
  }
  const conds = s.legalActions.filter((a) => a.type === 'play' && a.uid === p.uid && !!a.ape === !!p.ape).map((a) => (a as { condition: PredictionCondition }).condition);
  return `<div class="modal-bg"><div class="modal"><h2>Foresee: what will your opponent do next turn?</h2>
    ${conds.map((c) => `<button class="opt" data-cond="${c}">${PREDICTION_LABELS[c]} <span class="badge">Odds tier ${PREDICTION_TIERS[c]}</span></button>`).join('')}
    <button id="cancel">Cancel</button></div></div>`;
}

function onCardClick(uid: number) {
  const s = ui.snap;
  if (!s?.view || s.phase !== 'active' || s.seat === null) return;
  const legal = s.legalActions;
  const sel = ui.selected;
  // Completing a targeted play/attack?
  if (sel) {
    const match = legal.find((a) => (sel.kind === 'hand' ? a.type === 'play' && a.uid === sel.uid && a.target === uid && !!a.ape === !!ui.pendingPlay?.ape : a.type === 'attack' && a.attacker === sel.uid && a.target === uid));
    if (match) { ui.selected = undefined; return send(match); }
  }
  const inHand = s.view.hand.some((h) => h.uid === uid);
  if (inHand) {
    const plays = legal.filter((a) => a.type === 'play' && a.uid === uid);
    if (!plays.length) { ui.hint = s.view.active !== s.seat ? 'Not your turn.' : 'Not enough Gas (or no space/target).'; return render(); }
    if (plays.some((a) => a.type === 'play' && a.ape) && plays.some((a) => a.type === 'play' && !a.ape)) {
      ui.pendingPlay = { uid }; ui.modal = 'ape'; return render();
    }
    return continuePlay(uid, plays.every((a) => a.type === 'play' && a.ape));
  }
  const attacks = legal.filter((a) => a.type === 'attack' && a.attacker === uid);
  if (attacks.length) {
    ui.selected = { kind: 'unit', uid };
    ui.hint = 'Choose a target: an enemy unit or the enemy Treasury (Guard units must be hit first).';
    return render();
  }
  ui.selected = undefined;
  ui.hint = '';
  render();
}

function continuePlay(uid: number, ape: boolean) {
  const s = ui.snap!;
  const plays = s.legalActions.filter((a) => a.type === 'play' && a.uid === uid && !!a.ape === ape) as Extract<Action, { type: 'play' }>[];
  ui.pendingPlay = { uid, ape };
  if (plays.some((a) => a.condition)) { ui.modal = 'prediction'; return render(); }
  const targeted = plays.filter((a) => a.target !== undefined);
  if (targeted.length && !plays.some((a) => a.target === undefined)) {
    ui.selected = { kind: 'hand', uid };
    ui.hint = `Choose a target for ${card(s.view!.hand.find((h) => h.uid === uid)!.cardId).name}.`;
    return render();
  }
  send(plays.find((a) => a.target === undefined) ?? plays[0]);
}

function onTreasuryClick(seat: number) {
  const s = ui.snap;
  if (!s || seat === s.seat || ui.selected?.kind !== 'unit') return;
  const a = s.legalActions.find((x) => x.type === 'attack' && x.attacker === ui.selected!.uid && x.target === 'treasury');
  if (a) { ui.selected = undefined; send(a); }
}

async function send(action: Action) {
  ui.hint = '';
  await act(async () => {
    ui.snap = await client.move(ui.matchId!, ui.snap!, action);
    await pullEvents();
  });
}

// ─── Event log ───────────────────────────────────────────────────
function describe(e: GameEvent, seat: number | null): string | null {
  const who = (s: number) => (s === seat ? 'You' : 'Opponent');
  switch (e.t) {
    case 'turnStart': return `— Turn ${e.turn}: ${who(e.seat)} —`;
    case 'draw': return `You drew ${card(e.cardId).name}`;
    case 'play': return `${who(e.seat)} played ${card(e.cardId).name}${e.ape ? ' (aped in)' : ''}`;
    case 'predictionResolved': return `${who(e.seat)}'s prediction "${PREDICTION_LABELS[e.condition]}" ${e.hit ? 'came TRUE' : 'backfired'}`;
    case 'attack': return `${who(e.seat)} attacked ${e.target === 'treasury' ? 'the Treasury' : 'a unit'}`;
    case 'damage': return e.uid === 'treasury' ? `${who(e.seat)} Treasury −${e.n}` : null;
    case 'death': return `${card(e.cardId).name} (${who(e.seat).toLowerCase()}) was destroyed`;
    case 'hold': return `${who(e.seat)} Hold +1/+1`;
    case 'automate': return `${who(e.seat)} automation fired`;
    case 'apeDownside': return `Ape downside: ${e.kind}`;
    case 'fatigue': return `${who(e.seat)} fatigue ${e.n}`;
    case 'gameOver': return `Game over (${e.reason})`;
    default: return null;
  }
}

async function pullEvents() {
  if (!ui.matchId) return;
  const r = await client.events(ui.matchId, ui.eventCursor);
  ui.eventCursor = r.next;
  for (const e of r.events) { const d = describe(e, ui.snap?.seat ?? null); if (d) ui.log.push(d); }
}

// ─── Loop ────────────────────────────────────────────────────────
let lastKey = '';
function stateKey() {
  const s = ui.snap;
  return JSON.stringify([ui.screen, ui.queued, ui.matches.map((m) => [m.matchId, m.phase, m.turn]), s?.phase, s?.seq, s?.eventCount, ui.resultSigned, !!ui.settlement, ui.hint, ui.error]);
}

function tickClock() {
  const el = document.getElementById('clock');
  const s = ui.snap;
  if (!el || !s?.clock) return;
  const left = Math.max(0, Math.round((s.clock.turnEndsAt - Date.now()) / 1000));
  el.textContent = `${left}s + bank ${Math.round(s.clock.bank[s.clock.active] / 1000)}s`;
}

async function refresh(force = false) {
  await load();
  const key = stateKey();
  if (force || key !== lastKey) { lastKey = key; render(); }
}

async function load() {
  if (ui.screen === 'lobby') {
    const m = await client.matches().catch(() => ({ matches: [] }));
    ui.matches = m.matches as UI['matches'];
    if (ui.queued) {
      const q = await client.queueStatus();
      if (q.matchId) return void (await enterMatch(q.matchId));
    }
  } else if (ui.matchId) {
    let snap = await client.state(ui.matchId);
    if (snap.phase === 'reveal' && snap.seat !== null) { await client.reveal(ui.matchId).catch(() => {}); snap = await client.state(ui.matchId); }
    ui.snap = snap;
    await pullEvents();
    if (snap.phase === 'ended' && snap.seat !== null && !ui.resultSigned) {
      await client.signResult(ui.matchId).then(() => (ui.resultSigned = true)).catch(() => {});
    }
    if (snap.phase === 'ended' && !ui.settlement) ui.settlement = await client.settlement(ui.matchId).catch(() => undefined);
  }
}

async function act(fn: () => Promise<unknown>) {
  ui.error = undefined;
  try { await fn(); } catch (e) { ui.error = (e as Error).message; ui.hint = ui.error; }
  render();
}

function backToLobby() { ui.screen = 'lobby'; ui.matchId = undefined; refresh(true); }

function render() { ui.screen === 'lobby' ? renderLobby() : renderMatch(); }

async function boot() {
  app.innerHTML = '<p class="muted">Connecting…</p>';
  try { await client.connect(); } catch (e) {
    app.innerHTML = `<div class="panel">Could not reach the Forkfall server: ${escapeHtml(String(e))}<br/>Start it with <span class="mono">pnpm server</span>.</div>`;
    return;
  }
  await refresh(true);
  setInterval(() => { if (!ui.modal) refresh().catch(() => {}); }, 900);
  setInterval(tickClock, 1000);
}
boot();
