/**
 * Writes a static, self-contained metadata folder for CardRegistry (ERC-1155) that any host or IPFS
 * pin can serve as-is:
 *
 *   cards/<64-hex id>.json   per-token metadata (image embedded as an SVG data URI)
 *   images/<id>.svg          card images (for previews and galleries)
 *   contract.json            ERC-7572 collection metadata (CardRegistry.contractURI)
 *   index.html               preview gallery
 *
 *   pnpm art:export [outDir]      # default ./metadata-export
 *
 * Then pin the folder (e.g. `npx ipfs-car pack metadata-export --output cards.car`, or any pinning
 * service) and deploy with CARD_URI=ipfs://<cid>/cards/{id}.json CONTRACT_URI=ipfs://<cid>/contract.json.
 * Or skip this entirely: the referee server serves the same metadata at /metadata/... (see README).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cardMetadata, cardSvg, collectionMetadata, erc1155IdHex, STARTER_OFFSET, tokenIds } from '../src/index.ts';

const out = resolve(process.argv[2] ?? 'metadata-export');
for (const d of ['cards', 'images']) mkdirSync(join(out, d), { recursive: true });
const ids = tokenIds();
for (const id of ids) {
  writeFileSync(join(out, 'cards', `${erc1155IdHex(id)}.json`), JSON.stringify(cardMetadata(id), null, 2));
  const starter = id >= STARTER_OFFSET;
  writeFileSync(join(out, 'images', `${id}.svg`), cardSvg(starter ? id - STARTER_OFFSET : id, { starter }));
}
writeFileSync(join(out, 'contract.json'), JSON.stringify(collectionMetadata(), null, 2));
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Forkfall cards</title>
<style>body{background:#0a0c12;color:#e5e7eb;font:14px system-ui;margin:20px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}img{width:100%}</style>
<h1>Forkfall cards · ${ids.length} tokens</h1><main>${ids.map((id) => `<img src="images/${id}.svg" alt="${id}" loading="lazy">`).join('')}</main>`);
console.log(`wrote ${ids.length} token metadata files, images and contract.json to ${out}`);
console.log(`CARD_URI=<base>/cards/{id}.json  CONTRACT_URI=<base>/contract.json`);
