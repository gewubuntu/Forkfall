import { useCallback, useEffect, useRef } from 'react';

interface P { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; spin: boolean }

/**
 * Pixel-confetti bursts on a full-screen canvas. Returns the canvas ref and `burst(x, y, colors, n, power)`
 * in viewport coordinates. Square particles keep the pixel-art look; the loop only runs while particles live.
 */
export function useParticles() {
  const ref = useRef<HTMLCanvasElement>(null);
  const parts = useRef<P[]>([]);
  const raf = useRef(0);

  const loop = useCallback(() => {
    const cv = ref.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== innerWidth * dpr || cv.height !== innerHeight * dpr) { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    parts.current = parts.current.filter((p) => p.life > 0);
    for (const p of parts.current) {
      p.life -= 1; p.vy += 0.18; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy;
      g.globalAlpha = Math.min(1, (p.life / p.max) * 1.6);
      g.fillStyle = p.color;
      const s = p.spin && p.life % 8 < 4 ? p.size / 2 : p.size; // twinkle
      g.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
    }
    g.globalAlpha = 1;
    raf.current = parts.current.length ? requestAnimationFrame(loop) : 0;
  }, []);

  const burst = useCallback((x: number, y: number, colors: string[], n = 40, power = 7) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = power * (0.35 + Math.random() * 0.75);
      const max = 50 + Math.floor(Math.random() * 40);
      parts.current.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - power * 0.35, life: max, max,
        size: 3 + Math.floor(Math.random() * 3) * 2, color: colors[i % colors.length], spin: Math.random() < 0.4,
      });
    }
    if (!raf.current) raf.current = requestAnimationFrame(loop);
  }, [loop]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return { ref, burst };
}
