/**
 * Stands in for @forkfall/art's ponchoImages.ts in the web build (vite.config.ts): the base64 artwork there is
 * ~530 kB of JavaScript. The web app shows the same pictures from separate WebP files instead (lib/art.ts); the
 * share image fills this map with the embedded artwork on demand (lib/sharePull.ts).
 */
export const PONCHO_IMAGES: Record<number, string> = {};
