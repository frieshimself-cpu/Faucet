/**
 * Rewrites `site/scripts/data.js` from the engine's latest `site/data/faucet.json`.
 *
 * The site fetches the JSON when served over HTTP and falls back to this baked
 * copy when opened from disk. Keeping them in sync by hand is exactly the kind
 * of thing that silently rots, so it is a script.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const HEADER = `/* ═══════════════════════════════════════════════════════════════════════════
   data.js — the last-known-good dataset, baked in at build time.

   The page prefers the live file at \`data/faucet.json\`, which the engine
   rewrites on every cycle. This copy exists so the site still renders real
   numbers when it is opened straight off disk (file:// blocks fetch) or when
   the JSON has not been regenerated yet. Never hand-edit it: regenerate with
   \`npm run sync:fallback\`.
   ═══════════════════════════════════════════════════════════════════════════ */

window.FAUCET_FALLBACK = `;

const source = resolve('site/data/faucet.json');
const target = resolve('site/scripts/data.js');

const json = JSON.parse(await readFile(source, 'utf8'));
await writeFile(target, `${HEADER}${JSON.stringify(json, null, 2)};\n`, 'utf8');

process.stdout.write(`  synced ${target} from ${source}\n`);
