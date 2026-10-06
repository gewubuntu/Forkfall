/** Print the alpha metrics as CSV from a running referee: `pnpm metrics [days]` (SERVER_URL, default http://127.0.0.1:8787). */
const base = process.env.SERVER_URL ?? 'http://127.0.0.1:8787';
const days = Number(process.argv[2] ?? 30);
const res = await fetch(`${base}/v1/metrics?days=${days}&format=csv`);
if (!res.ok) { console.error(`${base}: ${res.status} ${await res.text()}`); process.exit(1); }
process.stdout.write(await res.text());
