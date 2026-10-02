import { cardDataUri } from '@forkfall/art';
import { card, type Rarity } from '@forkfall/engine';

const FOIL_OFFSET = 20_000;
const ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];
const split = (id: number) => (id >= FOIL_OFFSET ? { base: id - FOIL_OFFSET, foil: true } : { base: id, foil: false });

/** The headline of a pull: its best card, and any foils. */
export function pullHeadline(ids: number[], packName: string): string {
  const cards = ids.map(split);
  const best = cards.reduce((b, c) => (ORDER.indexOf(card(c.base).rarity) > ORDER.indexOf(card(b.base).rarity) ? c : b), cards[0]);
  const foils = cards.filter((c) => c.foil).map((c) => `✦ Foil ${card(c.base).name}`);
  const top = card(best.base);
  const lead = top.rarity === 'legendary' ? `a Legendary ${top.name}` : `${top.name} (${top.rarity})`;
  return `Pulled ${lead}${foils.length ? ` and ${foils.join(', ')}` : ''} from a Forkfall ${packName} 🎴`;
}

const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
  const img = new Image();
  img.onload = () => res(img);
  img.onerror = rej;
  img.src = src;
});

/** A 1200×630 share image (the size X and Farcaster previews use): the five cards on the pack's backdrop. */
export async function pullImage(ids: number[], packName: string): Promise<Blob> {
  const W = 1200, H = 630;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const bg = g.createRadialGradient(W / 2, H * 0.45, 40, W / 2, H / 2, W * 0.7);
  bg.addColorStop(0, '#1e3a8a'); bg.addColorStop(1, '#05070c');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.font = '800 40px Inter, Segoe UI, Arial, sans-serif'; g.textAlign = 'center';
  g.fillText(`My ${packName} pull`, W / 2, 70);
  const imgs = await Promise.all(ids.map((id) => { const c = split(id); return load(cardDataUri(c.base, { foil: c.foil })); }));
  const cw = 200, ch = 280, gap = 22, x0 = (W - (cw * 5 + gap * 4)) / 2, y = 120;
  imgs.forEach((img, i) => {
    const c = split(ids[i]);
    const r = card(c.base).rarity;
    if (r === 'legendary' || c.foil) { g.shadowColor = c.foil ? '#ff7ad9' : '#f472b6'; g.shadowBlur = 40; }
    else if (r === 'rare') { g.shadowColor = '#fbbf24'; g.shadowBlur = 24; }
    else g.shadowBlur = 0;
    g.drawImage(img, x0 + i * (cw + gap), y, cw, ch);
  });
  g.shadowBlur = 0;
  g.fillStyle = '#94a3b8'; g.font = '600 22px Inter, Segoe UI, Arial, sans-serif';
  g.fillText('Forkfall · the on-chain card game where humans and AI agents share one ladder · testnet', W / 2, H - 40);
  return new Promise((res) => cv.toBlob((b) => res(b!), 'image/png'));
}

/** Share links for the pull text and the app link. */
export function shareLinks(text: string, url: string) {
  return {
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    farcaster: `https://warpcast.com/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(url)}`,
  };
}

/** Native share sheet with the image when the browser supports it; otherwise download the image. */
export async function shareOrDownload(blob: Blob, text: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], 'forkfall-pull.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return 'shared'; } catch { /* cancelled: fall through to download */ }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'forkfall-pull.png' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return 'downloaded';
}
