/**
 * Forkfall Player Guide: an A4 PDF in the game's own look (dark shell, Pixelify Sans headings, race colours, the real
 * card frames and pixel sprites). Every rule number, card, keyword, quest and price is read from the engine, the art
 * package and the contracts, so the guide can't drift from the game: re-run it after a balance or rules change.
 *   pnpm guide [out.pdf]        (default docs/Forkfall-Player-Guide.pdf; the HTML it prints goes to the temp dir)
 * Uses Playwright's Chromium; set PLAYWRIGHT_CHROMIUM to a Chrome/Chromium binary if it isn't installed.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  APE_DISCOUNT, ASSET_SLOTS, BEATS, BOARD_SLOTS, card, COLLECTIBLE, COSMETICS, DECK_SIZE, DIVIDEND_CAP, FIRST_WIN_SCRAP,
  HAND_LIMIT, MAX_COPIES, MAX_LEGENDARIES_RANKED, MAX_GAS, MAX_LEGENDARY_COPIES, OPENING_HAND, PREDICTION_LABELS, PREDICTION_TIERS, QUESTS,
  QUESTS_PER_DAY, RACE_CHAIN, RACES, RANKED_RARITY_CAP, RARITY_POINTS, RULES_VERSION, setOf, STARTER_CARDS,
  STARTING_TREASURY, TOKEN_DRONE, TOKEN_TACO, TURN_LIMIT, type CardDef, type Faction, type PredictionCondition, type Race,
} from '../packages/engine/src/index.ts';
import { cardSvg, isPonchoArt, SPRITE_SIZE, spritePixels, spriteSvg } from '../packages/art/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'docs/Forkfall-Player-Guide.pdf'));

// ─── Values that live in the contracts and the referee, read from source so they stay in sync ───────────────────
const sol = (file: string) => readFileSync(join(root, 'contracts/src', file), 'utf8');
const solConst = (src: string, name: string) => Number(new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(src)![1].replaceAll('_', ''));
const solArray = (src: string, name: string) => /\[([^\]]+)\]\s*;/.exec(src.slice(src.indexOf(name)))![1].split(',').map((x) => Number(x.replace(/uint256\(|\)/g, '').trim()));
const crafting = sol('Crafting.sol'), packSale = sol('PackSale.sol');
const SCRAP_VALUE = solArray(crafting, 'scrapValue'); // common, uncommon, rare, legendary
const CRAFT_COST = solArray(crafting, 'craftCost');
const FOIL_SCRAP = solConst(crafting, 'FOIL_SCRAP_MULTIPLIER');
const PITY = solConst(packSale, 'PITY_PACKS');
const LEGENDARY_UPGRADE = solConst(packSale, 'LEGENDARY_UPGRADE_BPS') / 100;
const FOIL_ONE_IN = Math.round(10_000 / solConst(packSale, 'FOIL_BPS'));
const CARDS_PER_PACK = solConst(packSale, 'CARDS_PER_PACK');
const lobbySrc = readFileSync(join(root, 'apps/server/src/lobby.ts'), 'utf8');
const TURN_SECONDS = Number(/turnSeconds \?\? (\d+)/.exec(lobbySrc)![1]);
const BANK_SECONDS = Number(/bankSeconds \?\? (\d+)/.exec(lobbySrc)![1]);

// ─── Fonts: the web app's own, embedded so the PDF renders the same anywhere ────────────────────────────────────
// Inter comes from the static @fontsource/inter cut, not the variable one the web app loads: Chromium embeds a
// variable font in a PDF as Type 3 glyphs, which is several times larger and renders worse.
const webReq = createRequire(join(root, 'apps/web/package.json')), rootReq = createRequire(join(root, 'package.json'));
const font = (pkg: string, file: string, req = webReq) => readFileSync(join(dirname(req.resolve(`${pkg}/package.json`)), 'files', file)).toString('base64');
const FONTS = `
@font-face { font-family: 'Pixelify Sans'; font-weight: 400; src: url(data:font/woff2;base64,${font('@fontsource/pixelify-sans', 'pixelify-sans-latin-400-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Pixelify Sans'; font-weight: 700; src: url(data:font/woff2;base64,${font('@fontsource/pixelify-sans', 'pixelify-sans-latin-700-normal.woff2')}) format('woff2'); }
${[400, 600, 700].map((w) => `@font-face { font-family: 'Inter'; font-weight: ${w}; src: url(data:font/woff2;base64,${font('@fontsource/inter', `inter-latin-${w}-normal.woff2`, rootReq)}) format('woff2'); }`).join('\n')}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64 = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const cardImg = (id: number, cls = 'cardimg') => `<img class="${cls}" src="${b64(cardSvg(id))}" alt="${esc(card(id).name)}">`;
// Pixel sprites go in as PNGs scaled up 8× with hard pixel edges: as SVG every pixel is its own rectangle, which made
// the PDF several times larger. The Poncho set's vector art stays SVG.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function spritePng(id: number, scale = 8): string {
  const px = spritePixels(id), n = SPRITE_SIZE, w = n * scale;
  const raw = Buffer.alloc((w * 4 + 1) * w);
  for (let y = 0; y < w; y++) {
    const row = y * (w * 4 + 1); // filter byte 0, then RGBA
    for (let x = 0; x < w; x++) {
      const c = px[Math.floor(y / scale) * n + Math.floor(x / scale)];
      if (!c) continue;
      const o = row + 1 + x * 4;
      raw[o] = parseInt(c.slice(1, 3), 16); raw[o + 1] = parseInt(c.slice(3, 5), 16); raw[o + 2] = parseInt(c.slice(5, 7), 16); raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const spriteCache = new Map<number, string>();
const spriteSrc = (id: number) => { if (!spriteCache.has(id)) spriteCache.set(id, isPonchoArt(id) ? b64(spriteSvg(id)) : spritePng(id)); return spriteCache.get(id)!; };
const sprite = (id: number, cls = 'sprite') => `<img class="${cls}" src="${spriteSrc(id)}" alt="">`;
const RACE_NAME: Record<Faction, string> = { agents: 'Agents', prophets: 'Prophets', brokers: 'Brokers', degens: 'Degens', neutral: 'Neutral' };
const CHAIN_NAME = { base: 'Base', robinhood: 'Robinhood Chain' } as const;
const RARITIES = ['common', 'uncommon', 'rare', 'legendary'] as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const byCost = (a: CardDef, b: CardDef) => a.cost - b.cost || a.id - b.id;
const core = (f: Faction) => COLLECTIBLE.filter((c) => c.faction === f && setOf(c) === 'core').sort(byCost);
const legendaries = (r: Race) => core(r).filter((c) => c.rarity === 'legendary');
const beatenBy = (r: Race) => RACES.find((x) => BEATS[x] === r)!;

interface Page { html: string; cls?: string; race?: Faction; title?: string }
const pages: Page[] = [];
const toc: { title: string; page: number }[] = [];
function page(html: string, opts: Omit<Page, 'html'> = {}) {
  pages.push({ html, ...opts });
  if (opts.title) toc.push({ title: opts.title, page: pages.length });
}
const h1 = (kicker: string, title: string, lede?: string) =>
  `<header class="ph"><div class="kicker">${kicker}</div><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
const tip = (title: string, body: string, tone = '') => `<div class="tip ${tone}"><b>${title}</b><span>${body}</span></div>`;
const kw = (name: string, body: string, color = 'var(--base-2)') => `<div class="kw" style="--kc:${color}"><b>${name}</b><span>${body}</span></div>`;

// ─── Cover ───────────────────────────────────────────────────────────────────────────────────────────────────────
const coverCards = RACES.map((r) => legendaries(r)[0].id);
page(`
<div class="cover-glow base"></div><div class="cover-glow rh"></div>
<div class="cover-top">
  <div class="chainpill base">BASE</div><div class="vs">vs</div><div class="chainpill rh">ROBINHOOD CHAIN</div>
</div>
<div class="logo">FORKFALL</div>
<div class="cover-sub">Player Guide</div>
<p class="cover-pitch">Four crypto-native races. Fast, five-to-eight-minute duels. Humans and AI agents on the same ladder, every move signed, every card yours.</p>
<div class="fan">${coverCards.map((id, i) => `<div class="fan-card f${i}">${cardImg(id)}</div>`).join('')}</div>
<div class="race-strip">${RACES.map((r) => `<span style="--rc:var(--${r})">${RACE_NAME[r]}</span>`).join('')}</div>
<div class="cover-foot">Testnet alpha · Set 1 · ${COLLECTIBLE.length} collectible cards · rules v${RULES_VERSION}</div>
`, { cls: 'cover' });

// ─── Contents (filled in once every page is known) ───────────────────────────────────────────────────────────────
const contentsIndex = pages.length;
page('', { cls: 'contents' });

// ─── Welcome ─────────────────────────────────────────────────────────────────────────────────────────────────────
page(`
${h1('Start here', 'Welcome to Forkfall', 'A fast trading card game where the cards are yours and the opponent might be a bot with a wallet. Here is everything you need to go from your first click to your first ranked win.')}
<div class="grid3">
  <div class="panel step"><div class="step-n">1</div><h3>Play the tutorial</h3><p>Open <b>Learn</b>. The first lesson is a short, guided match against a scripted Degens bot, played in your browser: no wallet, no server, no chain. Three more lessons teach the Prophets', Brokers' and Degens' tricks.</p></div>
  <div class="panel step"><div class="step-n">2</div><h3>Claim starter decks</h3><p>Sign in with your wallet and claim the free starter decks, one per race. Starter cards are <b>soulbound</b>: they can't be sold, but they play everywhere, ranked included.</p></div>
  <div class="panel step"><div class="step-n">3</div><h3>Queue up</h3><p>Practice against the house bot, play Casual, climb Ranked, or send a friend a challenge link. Daily quests pay Scrap and free packs while you play.</p></div>
</div>
<h2>Signing in, once</h2>
<p>When you sign in, your wallet signs one message that authorizes a short-lived <b>session key</b> in your browser. That key signs your moves silently, so a match never pops a wallet window. Your wallet only signs the result at the end, which is what settles the match on-chain.</p>
<h2>Humans and agents, same rules</h2>
<p>Every move, human or AI, is a signed message under one protocol and goes through the same referee and the same ${TURN_SECONDS}-second turn timer. Agents are first-class players with a visible badge. The <b>Human queue</b> is open to every wallet that isn't a registered agent, if you'd rather only face people.</p>
<div class="grid2">
  ${tip('Cards are tokens', 'Collectible cards are ERC-1155 tokens on Base and Robinhood Chain; Legendaries also carry their own wallet. Where a card lives never changes how it plays.')}
  ${tip('Testnet alpha', 'Everything here runs on testnets. Cards, packs and tokens have no real value: never use a wallet that holds real funds.', 'warn')}
</div>
`, { title: 'Welcome to Forkfall' });

// ─── The match ───────────────────────────────────────────────────────────────────────────────────────────────────
const slot = (label: string, cls = '') => `<div class="slot ${cls}">${label}</div>`;
page(`
${h1('The basics', 'How a match works', `Drain your opponent's Treasury from ${STARTING_TREASURY} to 0. A match runs about 10 turns each and five to eight minutes.`)}
<div class="board">
  <div class="side opp">
    <div class="tre"><span class="pix">${STARTING_TREASURY}</span><small>Treasury</small></div>
    <div class="row">${Array.from({ length: BOARD_SLOTS }, (_, i) => slot(i === 1 ? sprite(18, 'bsprite') : i === 3 ? sprite(23, 'bsprite') : '', i === 1 || i === 3 ? 'filled' : '')).join('')}</div>
    <div class="assets">${Array.from({ length: ASSET_SLOTS }, () => slot('', 'asset')).join('')}</div>
  </div>
  <div class="mid"><span>Opponent's board</span><span class="line"></span><span>Your board</span></div>
  <div class="side me">
    <div class="tre"><span class="pix">${STARTING_TREASURY}</span><small>Treasury</small></div>
    <div class="row">${Array.from({ length: BOARD_SLOTS }, (_, i) => slot(i === 0 ? sprite(1, 'bsprite') : i === 2 ? sprite(8, 'bsprite') : '', i === 0 || i === 2 ? 'filled' : '')).join('')}</div>
    <div class="assets">${Array.from({ length: ASSET_SLOTS }, () => slot('', 'asset')).join('')}</div>
  </div>
  <div class="gas"><span class="pix">GAS</span>${Array.from({ length: MAX_GAS }, (_, i) => `<i class="${i < 6 ? 'on' : ''}"></i>`).join('')}<small>6 / 6</small></div>
  <div class="callouts">
    <div><b>${BOARD_SLOTS} unit slots</b> per side. Units fight, block and hit the Treasury.</div>
    <div><b>${ASSET_SLOTS} asset slots</b> for cards that stay in play without a body.</div>
    <div><b>Gas</b>: +1 max each turn up to ${MAX_GAS}, refilled every turn.</div>
  </div>
</div>
<div class="grid2">
  <div>
    <h2>Your turn</h2>
    <ol class="steps">
      <li><b>Start:</b> your max Gas goes up by 1 (to ${MAX_GAS} at most) and refills. You draw a card.</li>
      <li><b>Start-of-turn effects fire:</b> Hold growth and Dividends, queued Automate effects, and "at the start of your turn" cards.</li>
      <li><b>Play and attack</b> in any order: spend Gas on cards, then send each ready unit to attack once.</li>
      <li><b>End turn.</b> Predictions about the turn that just ended resolve.</li>
    </ol>
  </div>
  <div>
    <h2>Good to know</h2>
    <ul class="facts">
      <li>The first player starts with ${OPENING_HAND[0]} cards, the second with ${OPENING_HAND[1]}. Who goes first is random, from a seed both players commit to.</li>
      <li>A unit can't attack the turn it's played, unless it has <b>Rush</b>.</li>
      <li>Your hand holds ${HAND_LIMIT} cards. A card drawn into a full hand burns.</li>
      <li>An empty deck deals fatigue: 1 to your Treasury, then 2, then 3…</li>
      <li>After ${TURN_LIMIT / 2} turns each, the higher Treasury wins; equal is a draw.</li>
      <li>Turns last ${TURN_SECONDS} s, plus a ${BANK_SECONDS} s bank per match. Time out too often and you forfeit.</li>
    </ul>
  </div>
</div>
${tip('Randomness is fair', 'Every random roll (Pump, Ape, shuffles, “random enemy unit”) comes from a seed both players commit to before the match. Nobody, not even the referee, can steer it, and anyone can replay a finished match to check.')}
`, { title: 'How a match works' });

// ─── Card anatomy ────────────────────────────────────────────────────────────────────────────────────────────────
const anat = 24; // The Whale: a Legendary unit with Hold
page(`
${h1('Reading cards', 'Card anatomy')}
<div class="anatomy">
  <div class="anat-card">${cardImg(anat, 'cardimg big')}
    <span class="pin p1">1</span><span class="pin p2">2</span><span class="pin p3">3</span><span class="pin p4">4</span><span class="pin p5">5</span><span class="pin p6">6</span>
  </div>
  <ol class="anat-list">
    <li><b>Gas cost</b>: what it takes to play. Your Gas refills every turn.</li>
    <li><b>Chain badge</b>: BASE or RH (Robinhood Chain), the race's home chain. Neutral cards have none.</li>
    <li><b>Art and frame</b>: the frame's material shows rarity, from plain Common to the animated Legendary frame.</li>
    <li><b>Name and type</b>: Unit, Action, Prediction or Asset.</li>
    <li><b>Rules text</b>: keywords first, then what the card does.</li>
    <li><b>Attack and health</b> (units only). Damage stays until the unit dies; health doesn't reset each turn.</li>
  </ol>
</div>
<h2>Four card types</h2>
<div class="grid4">
  <div class="panel type"><h3>Unit</h3><p>Takes a board slot. Attacks once per turn, from the turn after it arrives. Dies at 0 health.</p></div>
  <div class="panel type"><h3>Action</h3><p>One-shot effect, then it's gone. Some need a target.</p></div>
  <div class="panel type"><h3>Prediction</h3><p>Prophets only: played face down with a call about your opponent's next turn. See <i>Predictions</i>.</p></div>
  <div class="panel type"><h3>Asset</h3><p>Stays in one of your ${ASSET_SLOTS} asset slots with a lasting effect. Has no body to attack.</p></div>
</div>
<h2>Rarity</h2>
<div class="rarities">${RARITIES.map((r) => {
  const ex = core('neutral').find((c) => c.rarity === r) ?? COLLECTIBLE.find((c) => c.rarity === r)!;
  return `<div class="rar">${cardImg(ex.id, 'cardimg mini')}<b class="r-${r}">${cap(r)}</b><small>${RARITY_POINTS[r]} ranked point${RARITY_POINTS[r] === 1 ? '' : 's'}</small></div>`;
}).join('')}</div>
`, { title: 'Card anatomy' });

// ─── Keywords ────────────────────────────────────────────────────────────────────────────────────────────────────
page(`
${h1('Glossary', 'Keywords', 'The words in bold on a card. The first six appear across races; the rest belong to one race each.')}
<h2>Combat keywords</h2>
<div class="kws">
  ${kw('Guard', 'Enemies must attack Guard units first: while one stands, nothing can hit your other units or your Treasury.')}
  ${kw('Rush', 'Can attack the turn it is played.')}
  ${kw('Hold', 'At the start of your turn, grows +1/+1 if it sat through your whole previous turn without attacking. A unit is first eligible on your second turn after it arrives.')}
  ${kw('Swarm', '+1 attack for each other friendly Swarm unit on the board.')}
  ${kw('Firewall', 'Deals 1 damage to every enemy unit as it is summoned.')}
  ${kw('Ape', `May be played for ${APE_DISCOUNT} less Gas, with one random downside: lose 2 Treasury, discard a random card, or the unit comes in with 1 less health.`)}
</div>
<h2>Race mechanics</h2>
<div class="kws two">
  ${kw('Automate', 'Agents. Queues an effect that fires at the start of your next turn, even if you pass.', 'var(--agents)')}
  ${kw('Deploy N', `Agents. Summons N Drones (${card(TOKEN_DRONE).attack}/${card(TOKEN_DRONE).health} tokens) into free unit slots.`, 'var(--agents)')}
  ${kw('Compute N', 'Agents. Your next card costs N less Gas.', 'var(--agents)')}
  ${kw('Foresee', 'Prophets. Play a prediction face down: pick what your opponent will do next turn.', 'var(--prophets)')}
  ${kw('Odds', 'Prophets. Bolder calls have a higher tier, and a correct call pays per tier.', 'var(--prophets)')}
  ${kw('Backfire', 'Prophets. A wrong call damages your own Treasury.', 'var(--prophets)')}
  ${kw('Dividend', `Brokers. Fires when the unit Holds: draw a card, gain Gas and so on. At most ${DIVIDEND_CAP} Dividends per turn.`, 'var(--brokers)')}
  ${kw('Portfolio', 'Brokers. When the unit dies, the tokens it holds (such as Bonds) drop onto your board.', 'var(--brokers)')}
  ${kw('Pump', 'Degens. A random boost of +1 to +3 stats, split at random between attack and health.', 'var(--degens)')}
  ${kw('Rug', 'Degens. Sacrifice one of your own units: it deals its attack plus a bonus straight to the enemy Treasury, past any Guard.', 'var(--degens)')}
</div>
`, { title: 'Keywords' });

// ─── Races overview ──────────────────────────────────────────────────────────────────────────────────────────────
const RACE: Record<Race, { fantasy: string; wins: string; style: string; mech: string[]; tips: string[] }> = {
  agents: {
    fantasy: 'Autonomous bots and launch machines.',
    wins: 'Scripted combos that fire without input, plus floods of Deployed Drones.',
    style: 'Predictable but efficient: you set things up, and they happen.',
    mech: ['Automate', 'Deploy', 'Compute'],
    tips: ['Compute before your big turn: a discounted 5-drop on turn 4 swings games.', 'Drones are chump blockers and Swarm-proof chip damage: fill the board before buffing it.', 'Automate fires even if you pass, so queue it the turn before you need it.'],
  },
  prophets: {
    fantasy: 'Oracles who trade on the future.',
    wins: 'Hidden predictions that pay off big when they come true.',
    style: 'Bluffs and reads: watch what your opponent does every turn, then call it.',
    mech: ['Foresee', 'Odds', 'Backfire'],
    tips: ['“Opponent attacks” is almost free against a board that can attack.', 'Several cards get stronger while you have an active prediction: play them after Foresee.', 'Call boldly when the read is clear; backfire hurts less than a missed lethal.'],
  },
  brokers: {
    fantasy: 'Patient capital and tokenized portfolios.',
    wins: 'Units that compound every turn they are held, paying Dividends.',
    style: 'Slow early, dominant late. Protect your holders and let time work.',
    mech: ['Hold', 'Dividend', 'Portfolio'],
    tips: ['Not attacking is a move: a holder that waits grows +1/+1 a turn.', 'A Guard in front keeps your holders safe while they compound.', 'Portfolio units are worth killing twice: plan for the tokens they drop.'],
  },
  degens: {
    fantasy: 'Meme swarms and launchpad chaos.',
    wins: 'Cheap swarms, random pumps and burst Treasury damage with Rugs.',
    style: 'High variance aggro. Go wide, go fast, finish with a Rug.',
    mech: ['Swarm', 'Pump', 'Rug', 'Ape'],
    tips: ['Swarm units scale with each other: three on board hit far above their cost.', 'Ape is a tempo tool: take the discount when the downside can’t lose you the game.', 'Rug goes straight past Guard: count your lethal before you attack.'],
  },
};
const cycle = (['prophets', 'agents', 'degens', 'brokers'] as Race[]);
page(`
${h1('Choose your side', 'The four races', 'Two chains, two tempos. Each chain has one slow race and one fast one, and every race beats the next around the cycle: a soft edge (about 55/45), never a lock.')}
<div class="cycle">
  ${cycle.map((r, i) => `<div class="cy cy${i}" style="--rc:var(--${r})">${sprite(legendaries(r)[0].id, 'cysprite')}<span><b>${RACE_NAME[r]}</b><small>${CHAIN_NAME[RACE_CHAIN[r]]}</small></span></div>`).join('')}
  <span class="a a0">beats →</span><span class="a a1">beats ↓</span><span class="a a2">← beats</span><span class="a a3">↑ beats</span>
  <div class="cy-axis top">BASE</div><div class="cy-axis bottom">ROBINHOOD CHAIN</div><div class="cy-axis left">SLOW</div><div class="cy-axis right">FAST</div>
</div>
<table class="tbl">
  <tr><th>Race</th><th>Chain</th><th>How it wins</th><th>Beats</th><th>Weak to</th></tr>
  ${RACES.map((r) => `<tr><td><b style="color:var(--${r})">${RACE_NAME[r]}</b></td><td>${CHAIN_NAME[RACE_CHAIN[r]]}</td><td>${RACE[r].wins}</td><td>${RACE_NAME[BEATS[r]]}</td><td>${RACE_NAME[beatenBy(r)]}</td></tr>`).join('')}
</table>
<p class="small muted">Every deck is one race plus Neutral cards. Neutral cards (including the Poncho collab set) fit any race.</p>
`, { title: 'The four races' });

// ─── One page per race ───────────────────────────────────────────────────────────────────────────────────────────
for (const r of RACES) {
  const info = RACE[r];
  const own = STARTER_CARDS[r].filter((id) => card(id).faction === r);
  const neutralStarters = STARTER_CARDS[r].filter((id) => card(id).faction === 'neutral');
  page(`
<div class="race-band" style="--rc:var(--${r})"></div>
<header class="ph race-head" style="--rc:var(--${r})">
  <div class="kicker">${CHAIN_NAME[RACE_CHAIN[r]]} · beats ${RACE_NAME[BEATS[r]]} · weak to ${RACE_NAME[beatenBy(r)]}</div>
  <h1 style="color:var(--rc)">${RACE_NAME[r]}</h1>
  <p class="lede">${info.fantasy} ${info.style}</p>
</header>
<div class="race-grid">
  <div>
    <h2>Mechanics</h2>
    <div class="chips">${info.mech.map((m) => `<span class="chip" style="--rc:var(--${r})">${m}</span>`).join('')}</div>
    <p>${info.wins}</p>
    <h2>Playing ${RACE_NAME[r]}</h2>
    <ul class="facts">${info.tips.map((t) => `<li>${t}</li>`).join('')}</ul>
    <h2>Starter deck</h2>
    <p class="small muted">Free and soulbound: 2 copies each of these ${STARTER_CARDS[r].length} cards (${DECK_SIZE} total). The ${neutralStarters.length} neutral cards are the same in every starter.</p>
    <div class="starter">${own.map((id) => `<div class="st">${sprite(id)}<span><b>${esc(card(id).name)}</b><small>${card(id).cost} Gas · ${card(id).type === 'unit' ? `${card(id).attack}/${card(id).health}` : card(id).type}</small></span></div>`).join('')}</div>
    <div class="starter neutral">${neutralStarters.map((id) => `<div class="st">${sprite(id)}<span><b>${esc(card(id).name)}</b><small>${card(id).cost} Gas</small></span></div>`).join('')}</div>
  </div>
  <div class="legends">
    <h2>Legendaries</h2>
    ${legendaries(r).map((c) => cardImg(c.id, 'cardimg leg')).join('')}
  </div>
</div>
`, { title: RACE_NAME[r], race: r });
}

// ─── Predictions ─────────────────────────────────────────────────────────────────────────────────────────────────
const preds = COLLECTIBLE.filter((c) => c.type === 'prediction').sort(byCost);
page(`
${h1('Prophets in depth', 'Predictions', 'A prediction is a call about what your opponent does on their next turn. You choose the call when you play the card, face down: they see that you predicted, not what.')}
<div class="grid2">
  <div>
    <h2>The calls</h2>
    <table class="tbl">
      <tr><th>Call</th><th>Tier</th></tr>
      ${(Object.keys(PREDICTION_TIERS) as PredictionCondition[]).map((c) => `<tr><td>${PREDICTION_LABELS[c]}</td><td><span class="tier">${'◆'.repeat(PREDICTION_TIERS[c])}</span> ${PREDICTION_TIERS[c]}</td></tr>`).join('')}
    </table>
    <p class="small muted">A “big unit” costs 4 Gas or more.</p>
  </div>
  <div>
    <h2>How it resolves</h2>
    <ol class="steps">
      <li>Play the prediction and pick a call. It sits face down.</li>
      <li>Your opponent takes their turn.</li>
      <li>When they end it, the call is checked against what they did that turn.</li>
      <li><b>Right:</b> the card pays its reward <i>times the tier</i>: Treasury damage or cards drawn. Cards that trigger on a correct prediction fire too.</li>
      <li><b>Wrong:</b> it backfires, damaging your own Treasury.</li>
    </ol>
  </div>
</div>
<h2>Prediction cards</h2>
<div class="cardrow">${preds.slice(0, 5).map((c) => cardImg(c.id, 'cardimg mid')).join('')}</div>
${tip('Reading the opponent', 'Players with units on board almost always attack; few players cast three cards before 6 Gas. Match the call to what their board and Gas make likely, then raise the tier when the read is strong.')}
`, { title: 'Predictions', race: 'prophets' });

// ─── Deckbuilding ────────────────────────────────────────────────────────────────────────────────────────────────
page(`
${h1('Make it yours', 'Building a deck')}
<div class="grid2">
  <div>
    <h2>The rules</h2>
    <ul class="facts">
      <li><b>${DECK_SIZE} cards</b>, from one race plus Neutral.</li>
      <li>At most <b>${MAX_COPIES} copies</b> of a card, and <b>${MAX_LEGENDARY_COPIES}</b> of a Legendary.</li>
      <li>You need to own the cards. Starter (soulbound) copies count.</li>
    </ul>
    <h2>Ranked rarity cap</h2>
    <p>Ranked decks spend at most <b>${RANKED_RARITY_CAP} rarity points</b> and hold at most <b>${MAX_LEGENDARIES_RANKED} Legendary</b>, so money buys breadth, not power. The deck builder shows the meter as you build.</p>
    <table class="tbl compact">
      <tr>${RARITIES.map((r) => `<th class="r-${r}">${cap(r)}</th>`).join('')}</tr>
      <tr>${RARITIES.map((r) => `<td class="pix big-n">${RARITY_POINTS[r]}</td>`).join('')}</tr>
    </table>
    <p class="small muted">For example: one Legendary (${RARITY_POINTS.legendary}) plus five Rares (${RARITY_POINTS.rare * 5}) is ${RARITY_POINTS.legendary + RARITY_POINTS.rare * 5} points, leaving ${RANKED_RARITY_CAP - RARITY_POINTS.legendary - RARITY_POINTS.rare * 5} for Uncommons.</p>
  </div>
  <div>
    <h2>A healthy curve</h2>
    <div class="curve">${[[1, 3], [2, 7], [3, 7], [4, 5], [5, 4], [6, 2], [7, 2]].map(([g, n]) => `<div class="bar"><i style="height:${n * 14}px"></i><span>${g}${g === 7 ? '+' : ''}</span></div>`).join('')}</div>
    <p class="small muted">A typical aggressive-to-midrange curve: lots of 2s and 3s so you use your Gas every turn, a few finishers on top.</p>
    <h2>Deck codes</h2>
    <p>Every deck can be shared as a short code starting <span class="mono">FF</span>. Paste one into the deck builder to open it; the builder shows the cards you're missing. A code holds the race and the card list, never an owner, and a checksum rejects typos.</p>
    <h2>Register for ranked</h2>
    <p>Ranked decks are registered on-chain once, and ownership is checked live: sell a card and the deck stops being ranked-legal until you replace it.</p>
  </div>
</div>
`, { title: 'Building a deck' });

// ─── Collection ──────────────────────────────────────────────────────────────────────────────────────────────────
page(`
${h1('Packs, Scrap, crafting', 'Your collection')}
<div class="grid2">
  <div>
    <h2>A pack</h2>
    <div class="pack">
      ${['common', 'common', 'common', 'uncommon', 'rare'].map((r, i) => `<div class="pk r-bg-${r}"><span>${i === 4 ? 'Rare*' : cap(r)}</span></div>`).join('')}
    </div>
    <p>${CARDS_PER_PACK} cards: 3 Common, 1 Uncommon and 1 Rare. <b>*</b> The Rare slot upgrades to a Legendary ${LEGENDARY_UPGRADE}% of the time.</p>
    <ul class="facts">
      <li><b>Pity timer:</b> a Legendary is guaranteed within ${PITY} packs. The shop shows how many are left.</li>
      <li><b>Duplicate protection:</b> a slot skips cards you already have a full playset of, until you own every card of that rarity.</li>
      <li><b>Foils:</b> about 1 card in ${FOIL_ONE_IN} is a foil, with an animated holo frame. It plays the same and scraps for ${FOIL_SCRAP}×.</li>
      <li><b>Fair rolls:</b> pack contents come from Chainlink VRF randomness (a committed future blockhash on testnets without VRF). Odds are published next to the Buy button and enforced by the contract.</li>
      <li><b>Bundles:</b> 5 packs 10% off, 10 packs 15% off. The Poncho booster only holds Poncho cards.</li>
    </ul>
    <div class="foilpair"><figure>${cardImg(16, 'cardimg mid')}<figcaption>Regular</figcaption></figure><figure><img class="cardimg mid" src="${b64(cardSvg(16, { foil: true }))}" alt="Foil"><figcaption>Foil</figcaption></figure></div>
  </div>
  <div>
    <h2>Scrap and crafting</h2>
    <p>Scrap your extra copies, then spend Scrap to craft exactly the card you want. Soulbound starter cards can't be scrapped, and foils can't be crafted.</p>
    <table class="tbl">
      <tr><th>Rarity</th><th>Scrap gives</th><th>Craft costs</th></tr>
      ${RARITIES.map((r, i) => `<tr><td class="r-${r}"><b>${cap(r)}</b></td><td class="pix">${SCRAP_VALUE[i]}</td><td class="pix">${CRAFT_COST[i]}</td></tr>`).join('')}
    </table>
    <h2>Set progress</h2>
    <p>Each set (the four races, Neutral and Poncho) tracks what you own, with cosmetic milestones along the way:</p>
    <table class="tbl compact">
      <tr><th>Milestone</th><th>Reward</th></tr>
      <tr><td>Every Common</td><td>Card back</td></tr>
      <tr><td>Every card</td><td>Title</td></tr>
      <tr><td>Full playset</td><td>Animated badge</td></tr>
    </table>
    <p class="small muted">Cosmetics are purely visual: titles, card backs and badges your opponents see. ${COSMETICS.length} to unlock.</p>
  </div>
</div>
`, { title: 'Your collection' });

// ─── Modes and quests ────────────────────────────────────────────────────────────────────────────────────────────
const questGroups = ['win', 'play', 'race'] as const;
page(`
${h1('Where to play', 'Modes, quests and rewards')}
<div class="grid2">
  <div>
    <h2>Modes</h2>
    <table class="tbl">
      <tr><th>Mode</th><th>What it is</th></tr>
      <tr><td><b>Practice</b></td><td>Against the house bot. Counts toward quests.</td></tr>
      <tr><td><b>Casual</b></td><td>Anyone waiting, no rating.</td></tr>
      <tr><td><b>Ranked</b></td><td>Season Elo, rarity cap on, results settled on-chain.</td></tr>
      <tr><td><b>Human queue</b></td><td>Ranked against people only (no registered agents).</td></tr>
      <tr><td><b>Agent League</b></td><td>For registered agents: weekly league with entry fees and a pot (test USDC).</td></tr>
    </table>
    <h2>Matchmaking</h2>
    <p>Rated queues start everyone at 1200 and pair the closest rating within ±100. The window widens by 50 every 10 seconds, and after a minute anyone in the queue will do.</p>
    <h2>Friends and rematches</h2>
    <p><b>Play → Friend</b> makes a challenge link that works even before your friend has a wallet: the page walks them through signing in. Your race stays hidden until the match starts. After any match against a real opponent, hit <b>Rematch</b>.</p>
  </div>
  <div>
    <h2>Daily quests</h2>
    <p>${QUESTS_PER_DAY} quests a day (reset at 00:00 UTC), one from each group, plus one reroll:</p>
    <div class="quests">${questGroups.map((grp) => `<div class="qg"><b>${cap(grp)}</b>${QUESTS.filter((q) => q.group === grp).slice(0, 4).map((q) => `<span>${esc(q.text)} <i>${q.scrap}</i></span>`).join('')}</div>`).join('')}</div>
    <ul class="facts">
      <li><b>First win of the day:</b> ${FIRST_WIN_SCRAP} Scrap.</li>
      <li><b>Free pack:</b> complete 10 daily quests in a week (Monday to Sunday, UTC).</li>
      <li>Matches shorter than four turns each don't count.</li>
      <li>Rewards go to verified humans and registered agents. Earned before verifying? They're held for 40 days and paid when you verify.</li>
    </ul>
    <h2>Seasons</h2>
    <p>Ranked results settle on-chain with both players' signatures and update the season ladder. Season rewards are claimed on your Profile page.</p>
  </div>
</div>
`, { title: 'Modes, quests and rewards' });

// ─── Card list ───────────────────────────────────────────────────────────────────────────────────────────────────
const statLine = (c: CardDef) => (c.type === 'unit' ? `<span class="atk">${c.attack}</span><span class="hp">${c.health}</span>` : `<span class="ty">${c.type}</span>`);
const row = (c: CardDef) => `<div class="cl">${sprite(c.id, 'clsprite')}<div class="clm"><div class="cln"><span class="gem">${c.cost}</span><b class="r-${c.rarity}">${esc(c.name)}</b>${statLine(c)}</div><p>${esc(c.text)}</p></div></div>`;
const groups: { title: string; faction: Faction; cards: CardDef[] }[] = [
  ...RACES.map((r) => ({ title: RACE_NAME[r], faction: r as Faction, cards: core(r) })),
  { title: 'Neutral', faction: 'neutral', cards: core('neutral') },
  { title: 'Poncho collab set', faction: 'neutral', cards: COLLECTIBLE.filter((c) => setOf(c) === 'poncho').sort(byCost) },
  { title: 'Tokens', faction: 'neutral', cards: [TOKEN_DRONE, 1001, TOKEN_TACO].map((id) => card(id)) },
];
// Pages are filled by estimated height (mm): a group heading, then rows of two cards.
const ROW_MM = 19.5, HEAD_MM = 13, PAGE_MM = 242, FIRST_MM = 222;
let parts: string[] = [], used = 0, budget = FIRST_MM, firstList = true, pageRace: Faction | undefined;
const flush = () => {
  if (!parts.length) return;
  page(`${firstList ? h1('Reference', 'Card list', 'Every collectible card, by race, then cost. Name colour shows rarity.') : ''}${parts.join('')}`,
    { title: firstList ? 'Card list' : undefined, race: pageRace, cls: 'list' });
  parts = []; used = 0; budget = PAGE_MM; firstList = false; pageRace = undefined;
};
for (const g of groups) {
  for (let i = 0; i < g.cards.length;) {
    if (used + HEAD_MM + ROW_MM > budget) flush();
    const rows = Math.floor((budget - used - HEAD_MM) / ROW_MM);
    const chunk = g.cards.slice(i, i + rows * 2);
    pageRace ??= g.faction;
    parts.push(`<h2 class="list-h" style="color:var(--${g.faction})">${g.title} <small>${i === 0 ? `${g.cards.length} cards` : 'continued'}</small></h2><div class="clist">${chunk.map(row).join('')}</div>`);
    used += HEAD_MM + Math.ceil(chunk.length / 2) * ROW_MM;
    i += chunk.length;
  }
}
flush();

// ─── Back cover ──────────────────────────────────────────────────────────────────────────────────────────────────
page(`
<div class="cover-glow base"></div><div class="cover-glow rh"></div>
<div class="back">
  <div class="logo small">FORKFALL</div>
  <p class="cover-pitch">See you on the ladder.</p>
  <div class="row-sprites">${RACES.map((r) => sprite(legendaries(r)[0].id, 'bigsprite')).join('')}</div>
  <p class="small muted">Generated from the game's own rules engine and card data (rules v${RULES_VERSION}). Numbers are testnet starting values and change with balance patches.</p>
</div>
`, { cls: 'cover' });

// ─── Contents page ───────────────────────────────────────────────────────────────────────────────────────────────
pages[contentsIndex].html = `
${h1('Inside', 'Contents')}
<ol class="toc">${toc.map((t) => `<li><span>${t.title}</span><i></i><b class="pix">${t.page}</b></li>`).join('')}</ol>
<div class="toc-sprites">${[1, 9, 17, 25, 33, 38].map((id) => sprite(id, 'tsprite')).join('')}</div>
`;

// ─── Document ────────────────────────────────────────────────────────────────────────────────────────────────────
const CSS = `
${FONTS}
:root {
  --bg: #0a0c12; --bg-2: #0e1119; --panel: #141823; --panel-2: #1a1f2d; --panel-3: #212739; --line: #252b3c; --line-2: #323a51;
  --text: #eef1f8; --muted: #9198ad; --dim: #626a81;
  --base: #3b82f6; --base-2: #38bdf8; --rh: #22c55e; --rh-2: #a3e635;
  --agents: #22d3ee; --prophets: #8b7cff; --brokers: #22c55e; --degens: #ff4fa8; --neutral: #9aa3b5; --poncho: #ff9f2e;
  --warn: #f5b84a;
  --c-common: #c9d1e0; --c-uncommon: #4ade80; --c-rare: #60a5fa; --c-legendary: #f59e0b;
}
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; font-size: 10pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; height: 297mm; padding: 16mm 15mm 18mm; position: relative; overflow: hidden; page-break-after: always; break-after: page;
  background: radial-gradient(120% 60% at 0% 0%, rgba(59,130,246,.10), transparent 60%), radial-gradient(120% 60% at 100% 100%, rgba(34,197,94,.08), transparent 60%), var(--bg); }
.page:last-child { page-break-after: auto; break-after: auto; }
.page[data-race] { background: radial-gradient(110% 50% at 100% 0%, color-mix(in srgb, var(--rc) 16%, transparent), transparent 60%), var(--bg); }
.foot { position: absolute; left: 15mm; right: 15mm; bottom: 8mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: var(--dim); border-top: 1px solid var(--line); padding-top: 2.5mm; }
.foot b { font-family: 'Pixelify Sans'; font-weight: 700; color: var(--muted); font-size: 9pt; }
.pix, h1, h2, h3, .kicker, .logo, .step-n { font-family: 'Pixelify Sans', monospace; }
h1 { font-size: 30pt; line-height: 1; margin: 0 0 3mm; letter-spacing: .02em; }
h2 { font-size: 14pt; margin: 6mm 0 2.5mm; letter-spacing: .03em; color: var(--text); }
h3 { font-size: 12pt; margin: 0 0 1.5mm; }
p { margin: 0 0 2.5mm; }
.ph { margin-bottom: 4mm; }
.kicker { color: var(--base-2); text-transform: uppercase; letter-spacing: .16em; font-size: 9pt; margin-bottom: 2mm; }
.lede { color: var(--muted); font-size: 11.5pt; max-width: 165mm; }
.small { font-size: 8.5pt; } .muted { color: var(--muted); } .mono { font-family: ui-monospace, monospace; font-size: .9em; color: var(--base-2); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 4mm; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; margin: 4mm 0 2mm; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
.step-n { font-size: 24pt; color: var(--base-2); line-height: 1; margin-bottom: 2mm; }
.step p, .type p { font-size: 9pt; color: var(--muted); margin: 0; }
.type h3 { color: var(--base-2); }
.tip { display: grid; gap: 1mm; border-left: 3px solid var(--base-2); background: color-mix(in srgb, var(--base) 10%, var(--panel)); padding: 3mm 4mm; border-radius: 0 8px 8px 0; margin-top: 5mm; font-size: 9pt; }
.tip b { font-family: 'Pixelify Sans'; font-size: 11pt; color: var(--base-2); }
.tip.warn { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); } .tip.warn b { color: var(--warn); }
ul.facts, ol.steps { margin: 0; padding-left: 5mm; } ul.facts li, ol.steps li { margin-bottom: 1.8mm; }
ol.steps li::marker { font-family: 'Pixelify Sans'; color: var(--base-2); }
ul.facts li::marker { color: var(--base-2); }
.tbl { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 1mm 0 3mm; }
.tbl th { text-align: left; font-family: 'Pixelify Sans'; font-weight: 400; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 8pt; border-bottom: 1px solid var(--line-2); padding: 1.5mm 2mm; }
.tbl td { border-bottom: 1px solid var(--line); padding: 1.8mm 2mm; vertical-align: top; }
.tbl.compact td, .tbl.compact th { text-align: center; }
.big-n { font-size: 16pt; }
.r-common { color: var(--c-common); } .r-uncommon { color: var(--c-uncommon); } .r-rare { color: var(--c-rare); } .r-legendary { color: var(--c-legendary); }
.sprite, .bsprite, .clsprite, .cysprite, .bigsprite, .tsprite { image-rendering: pixelated; }
/* No CSS filters on repeated images: Chromium rasterizes each one into the PDF. */
.cardimg { display: block; }
.fan-card .cardimg { filter: drop-shadow(0 6px 14px rgba(0,0,0,.55)); }
.cardimg.big { width: 72mm; } .cardimg.mini { width: 30mm; } .cardimg.mid { width: 33mm; } .cardimg.leg { width: 58mm; margin-bottom: 5mm; }

/* cover */
.cover { display: flex; flex-direction: column; align-items: center; text-align: center; padding-top: 22mm; }
.cover-glow { position: absolute; width: 230mm; height: 230mm; border-radius: 50%; }
.cover-glow.base { background: radial-gradient(closest-side, rgba(59,130,246,.5), rgba(59,130,246,.18) 55%, transparent); left: -100mm; top: -80mm; }
.cover-glow.rh { background: radial-gradient(closest-side, rgba(34,197,94,.4), rgba(34,197,94,.14) 55%, transparent); right: -110mm; bottom: -100mm; }
.cover > *:not(.cover-glow):not(.cover-foot) { position: relative; }
.cover-top { display: flex; gap: 4mm; align-items: center; font-family: 'Pixelify Sans'; letter-spacing: .14em; }
.chainpill { padding: 1.5mm 4mm; border-radius: 99px; font-size: 9pt; } .chainpill.base { background: #1d4ed8; color: #dbeafe; } .chainpill.rh { background: #15803d; color: #dcfce7; }
.vs { color: var(--muted); font-size: 10pt; }
.logo { font-size: 64pt; font-weight: 700; letter-spacing: .06em; margin-top: 10mm; line-height: 1;
  background: linear-gradient(180deg, #fff 0%, #cfe3ff 55%, #7dd3fc 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 4px 0 #0b1a33) drop-shadow(0 0 18px rgba(59,130,246,.55)); }
.logo.small { font-size: 40pt; margin-top: 0; }
.cover-sub { font-family: 'Pixelify Sans'; font-size: 20pt; letter-spacing: .3em; text-transform: uppercase; color: var(--rh-2); margin-top: 3mm; }
.cover-pitch { font-size: 12.5pt; color: #cbd2e1; max-width: 140mm; margin: 7mm auto 0; }
.fan { position: relative; height: 140mm; width: 180mm; margin-top: 14mm; }
.fan-card { position: absolute; top: 0; left: 50%; width: 60mm; transform-origin: 50% 120%; }
.fan-card .cardimg { width: 60mm; }
.f0 { transform: translateX(-125%) rotate(-12deg); } .f1 { transform: translateX(-75%) rotate(-4deg) translateY(-4mm); }
.f2 { transform: translateX(-25%) rotate(4deg) translateY(-4mm); } .f3 { transform: translateX(25%) rotate(12deg); }
.race-strip { display: flex; gap: 4mm; margin-top: 6mm; } .race-strip span { font-family: 'Pixelify Sans'; color: var(--rc); border: 1px solid var(--rc); border-radius: 99px; padding: 1mm 5mm; font-size: 11pt; letter-spacing: .08em; box-shadow: 0 0 12px color-mix(in srgb, var(--rc) 35%, transparent); }
.cover-foot { position: absolute; bottom: 14mm; font-family: 'Pixelify Sans'; color: var(--muted); letter-spacing: .1em; font-size: 9pt; }
.back { margin-top: 70mm; display: flex; flex-direction: column; align-items: center; gap: 6mm; text-align: center; max-width: 150mm; }
.row-sprites { display: flex; gap: 8mm; } .bigsprite { width: 28mm; }

/* contents */
.toc { list-style: none; padding: 0; margin: 6mm 0 0; counter-reset: t; }
.toc li { display: flex; align-items: baseline; gap: 3mm; font-size: 13pt; padding: 2.4mm 0; counter-increment: t; }
.toc li::before { content: counter(t, decimal-leading-zero); font-family: 'Pixelify Sans'; color: var(--base-2); width: 9mm; }
.toc li i { flex: 1; border-bottom: 1px dotted var(--line-2); transform: translateY(-1mm); }
.toc li b { font-size: 13pt; color: var(--muted); }
.toc-sprites { position: absolute; bottom: 22mm; left: 15mm; right: 15mm; display: flex; justify-content: space-between; opacity: .9; } .tsprite { width: 22mm; }

/* board */
.board { position: relative; background: var(--bg-2); border: 1px solid var(--line-2); border-radius: 14px; padding: 5mm; margin: 2mm 0 2mm; display: grid; gap: 2.5mm; }
.side { display: grid; grid-template-columns: 22mm 1fr 34mm; gap: 3mm; align-items: center; }
.tre { background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 10px; text-align: center; padding: 2mm; }
.tre .pix { font-size: 20pt; display: block; line-height: 1; color: var(--warn); } .tre small { color: var(--muted); font-size: 7pt; text-transform: uppercase; letter-spacing: .1em; }
.row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 2mm; }
.slot { height: 18mm; border: 1.5px dashed var(--line-2); border-radius: 8px; display: grid; place-items: center; }
.slot.filled { border-style: solid; border-color: var(--base); background: var(--panel); } .side.opp .slot.filled { border-color: var(--rh); }
.slot.asset { height: 11mm; border-color: #3a3f55; }
.assets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5mm; }
.bsprite { width: 14mm; }
.mid { display: flex; align-items: center; gap: 3mm; color: var(--dim); font-size: 7.5pt; text-transform: uppercase; letter-spacing: .12em; } .mid .line { flex: 1; height: 1px; background: var(--line-2); }
.gas { display: flex; align-items: center; gap: 1.2mm; margin-top: 1mm; } .gas .pix { color: var(--base-2); margin-right: 2mm; }
.gas i { width: 5mm; height: 5mm; transform: rotate(45deg); border: 1px solid var(--base); } .gas i.on { background: var(--base-2); box-shadow: 0 0 6px var(--base-2); }
.gas small { margin-left: 3mm; color: var(--muted); }
.callouts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; font-size: 8.5pt; color: var(--muted); margin-top: 1mm; } .callouts b { color: var(--text); }

/* anatomy */
.anatomy { display: grid; grid-template-columns: 80mm 1fr; gap: 8mm; align-items: center; }
.anat-card { position: relative; width: 72mm; }
.pin { position: absolute; width: 7mm; height: 7mm; border-radius: 50%; background: var(--warn); color: #1a1200; font-family: 'Pixelify Sans'; font-weight: 700; display: grid; place-items: center; font-size: 10pt; box-shadow: 0 0 0 2px #0b0d12; }
.p1 { left: -3mm; top: 2mm; } .p2 { right: -3mm; top: 3mm; } .p3 { right: 4mm; top: 32mm; } .p4 { left: -3mm; top: 61mm; } .p5 { right: -3mm; top: 72mm; } .p6 { left: 32mm; bottom: -3mm; }
.anat-list { font-size: 10.5pt; padding-left: 6mm; } .anat-list li { margin-bottom: 3mm; } .anat-list li::marker { font-family: 'Pixelify Sans'; color: var(--warn); }
.rarities { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; text-align: center; }
.rar { display: flex; flex-direction: column; align-items: center; gap: 1mm; } .rar b { font-family: 'Pixelify Sans'; font-size: 12pt; } .rar small { color: var(--muted); }

/* keywords */
.kws { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm; }
.kw { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--kc); border-radius: 8px; padding: 2mm 3.5mm; font-size: 9pt; }
.kw b { display: block; font-family: 'Pixelify Sans'; font-size: 12pt; color: var(--kc); margin-bottom: .5mm; } .kw span { color: #cfd5e3; }

/* races */
.cycle { position: relative; width: 150mm; height: 84mm; margin: 8mm auto 8mm; }
.cy { position: absolute; width: 60mm; height: 26mm; background: var(--panel); border: 1.5px solid var(--rc); border-radius: 12px; display: flex; align-items: center; gap: 3mm; padding: 3mm; box-shadow: 0 0 18px color-mix(in srgb, var(--rc) 25%, transparent); }
.cy b { font-family: 'Pixelify Sans'; font-size: 15pt; color: var(--rc); display: block; line-height: 1.1; } .cy small { color: var(--muted); font-size: 8pt; }
.cy0 { left: 0; top: 8mm; } .cy1 { right: 0; top: 8mm; } .cy2 { right: 0; bottom: 8mm; } .cy3 { left: 0; bottom: 8mm; }
.cysprite { width: 18mm; }
.a { position: absolute; font-family: 'Pixelify Sans'; color: var(--warn); font-size: 10pt; white-space: nowrap; }
.a0 { left: 75mm; top: 18mm; transform: translateX(-50%); }
.a1 { right: 30mm; top: 42mm; transform: translate(50%, -50%); }
.a2 { left: 75mm; bottom: 18mm; transform: translateX(-50%); }
.a3 { left: 30mm; top: 42mm; transform: translate(-50%, -50%); }
.cy-axis { position: absolute; font-family: 'Pixelify Sans'; font-size: 7.5pt; letter-spacing: .2em; color: var(--dim); }
.cy-axis.top { top: 0; left: 50%; transform: translateX(-50%); color: #93c5fd; } .cy-axis.bottom { bottom: 0; left: 50%; transform: translateX(-50%); color: #86efac; }
.cy-axis.left { left: -12mm; top: 50%; transform: translateY(-50%) rotate(-90deg); } .cy-axis.right { right: -12mm; top: 50%; transform: translateY(-50%) rotate(90deg); }
.race-band { position: absolute; left: 0; top: 0; bottom: 0; width: 5mm; background: var(--rc); }
.race-head .kicker { color: var(--rc); }
.race-head h1 { font-size: 40pt; text-shadow: 0 0 22px color-mix(in srgb, var(--rc) 50%, transparent); }
.race-grid { display: grid; grid-template-columns: 1fr 60mm; gap: 8mm; }
.chips { display: flex; gap: 2mm; margin-bottom: 2.5mm; } .chip { border: 1px solid var(--rc); color: var(--rc); border-radius: 99px; padding: .8mm 3.5mm; font-family: 'Pixelify Sans'; font-size: 10pt; }
.starter { display: grid; grid-template-columns: 1fr 1fr; gap: 1.8mm; margin-bottom: 2mm; }
.st { display: flex; align-items: center; gap: 2mm; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 1.2mm 2mm; }
.st .sprite { width: 9mm; } .st b { display: block; font-size: 8.5pt; line-height: 1.2; } .st small { color: var(--muted); font-size: 7.5pt; }
.starter.neutral .st { opacity: .8; } .starter.neutral .sprite { width: 7mm; }
.legends h2 { margin-top: 0; }

/* predictions & misc */
.tier { color: var(--prophets); letter-spacing: .1em; }
.foilpair { display: flex; gap: 6mm; margin-top: 4mm; } .foilpair figure { margin: 0; text-align: center; } .foilpair figcaption { font-family: 'Pixelify Sans'; color: var(--muted); font-size: 9pt; margin-top: 1.5mm; }
.cardrow { display: flex; gap: 3mm; justify-content: space-between; }
.curve { display: flex; align-items: flex-end; gap: 3mm; height: 36mm; padding: 2mm 0; border-bottom: 1px solid var(--line-2); }
.bar { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1mm; } .bar i { width: 100%; background: linear-gradient(180deg, var(--base-2), var(--base)); border-radius: 4px 4px 0 0; }
.bar span { font-family: 'Pixelify Sans'; color: var(--muted); font-size: 9pt; }
.pack { display: flex; gap: 2mm; margin-bottom: 3mm; }
.pk { flex: 1; height: 26mm; border-radius: 8px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 2mm; font-family: 'Pixelify Sans'; font-size: 8.5pt; border: 1px solid rgba(255,255,255,.15); }
.r-bg-common { background: linear-gradient(160deg, #3b4254, #232838); } .r-bg-uncommon { background: linear-gradient(160deg, #166534, #14301f); }
.r-bg-rare { background: linear-gradient(160deg, #1d4ed8, #172554); box-shadow: 0 0 14px rgba(245,158,11,.45); }
.quests { display: grid; gap: 2mm; margin-bottom: 3mm; }
.qg { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 2mm 3mm; font-size: 8.5pt; display: grid; gap: .6mm; }
.qg b { font-family: 'Pixelify Sans'; color: var(--base-2); font-size: 10pt; }
.qg i { font-style: normal; font-family: 'Pixelify Sans'; color: var(--warn); float: right; } .qg i::after { content: ' Scrap'; color: var(--dim); font-size: 7pt; }

/* card list */
.list-h { font-size: 16pt; margin: 2mm 0 3mm; } .list-h small { font-size: 9pt; color: var(--muted); margin-left: 2mm; letter-spacing: .05em; }
.clist { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm 4mm; }
.cl { display: flex; gap: 2.5mm; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 2mm; min-height: 19mm; break-inside: avoid; }
.clsprite { width: 13mm; height: 13mm; flex: none; }
.clm { flex: 1; min-width: 0; } .clm p { font-size: 7.6pt; color: #c3cad9; margin: .8mm 0 0; line-height: 1.32; }
.cln { display: flex; align-items: center; gap: 1.5mm; font-size: 9pt; } .cln b { flex: 1; font-size: 9pt; line-height: 1.15; }
.gem { flex: none; width: 5.5mm; height: 5.5mm; border-radius: 50%; background: #0b1a33; border: 1.5px solid var(--base-2); display: grid; place-items: center; font-family: 'Pixelify Sans'; font-weight: 700; font-size: 8.5pt; }
.atk, .hp { font-family: 'Pixelify Sans'; font-weight: 700; font-size: 9pt; width: 5.5mm; height: 5.5mm; display: grid; place-items: center; border-radius: 50%; flex: none; }
.atk { background: #b45309; } .hp { background: #b91c1c; }
.ty { font-size: 7pt; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); border: 1px solid var(--line-2); border-radius: 99px; padding: .2mm 2mm; }
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forkfall Player Guide</title><style>${CSS}</style></head><body>
${pages.map((p, i) => `<section class="page ${p.cls ?? ''}"${p.race ? ` data-race style="--rc:var(--${p.race})"` : ''}>${p.html}${p.cls === 'cover' ? '' : `<div class="foot"><span>FORKFALL · PLAYER GUIDE · TESTNET ALPHA</span><b>${i + 1}</b></div>`}</section>`).join('\n')}
</body></html>`;

const htmlPath = join(tmpdir(), 'forkfall-player-guide.html');
writeFileSync(htmlPath, html);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const tab = await browser.newPage();
await tab.goto(`file://${htmlPath}`);
await tab.evaluate(() => document.fonts.ready);
await tab.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log(`${out}: ${pages.length} pages`);
