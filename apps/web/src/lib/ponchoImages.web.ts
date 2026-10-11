/**
 * Stands in for @forkfall/art's ponchoImages.ts in the web build (vite.config.ts): the base64 artwork there is
 * ~530 kB of JavaScript. The web app shows the same pictures from separate WebP files instead (lib/art.ts).
 */
export const PONCHO_IMAGES: Record<number, string> = {};
