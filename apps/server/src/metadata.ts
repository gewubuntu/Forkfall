import { cardMetadata, cardSvg, collectionMetadata, parseTokenId, splitTokenId } from '@forkfall/art';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Card metadata for CardRegistry, generated on the fly from the card set (deploy with
 * METADATA_BASE=https://<this server>/metadata):
 *   GET /metadata/cards/<id>.json    ERC-1155 metadata; <id> as the 64-hex `{id}` or a decimal token id
 *   GET /metadata/images/<id>.svg    full card image
 *   GET /metadata/contract.json      ERC-7572 collection metadata (contractURI)
 */
export function serveMetadata(req: IncomingMessage, res: ServerResponse, path: string, publicUrl?: string): boolean {
  if (!path.startsWith('/metadata/')) return false;
  const origin = publicUrl ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host ?? 'localhost'}`;
  const send = (type: string, body: string) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
    res.end(body);
  };
  const m = /^\/metadata\/(cards|images)\/([^/]+)$/.exec(path);
  if (path === '/metadata/contract.json') {
    send('application/json', JSON.stringify(collectionMetadata({ image: `${origin}/metadata/images/8.svg`, appUrl: origin })));
  } else if (m && parseTokenId(m[2]) !== null && (m[1] === 'cards' ? m[2].endsWith('.json') : m[2].endsWith('.svg'))) {
    const id = parseTokenId(m[2])!;
    if (m[1] === 'cards') send('application/json', JSON.stringify(cardMetadata(id, { imageBase: `${origin}/metadata/images`, appUrl: origin })));
    else { const t = splitTokenId(id); send('image/svg+xml', cardSvg(t.baseId, { starter: t.starter, foil: t.foil })); }
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such card metadata' }));
  }
  return true;
}
