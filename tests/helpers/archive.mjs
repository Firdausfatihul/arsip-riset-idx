// The built archive the integration tests read. tools/test.sh builds it into a temp folder and sets
// ARSIP_TEST_SITE / ARSIP_TEST_ASSETS; without them the repo's site/ and worker/.assets are used.
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SITE = process.env.ARSIP_TEST_SITE || path.join(ROOT, 'site');
export const ASSETS = process.env.ARSIP_TEST_ASSETS || path.join(ROOT, 'worker/.assets');

export const readAsset = async (name, dir = ASSETS) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
// The Worker's ASSETS binding over a folder: a missing file answers 404.
export const assetsAt = dir => ({async fetch(request) {
  try { return new Response(await readFile(path.join(dir, decodeURIComponent(new URL(request.url).pathname)))); }
  catch { return new Response('Not found', {status:404}); }
}});
export const assets = assetsAt(ASSETS);

// Worker assets of the four raw Stockbit reports of 3–5 October, as chat indexed them before sbringkas
// covered those days (build_worker.worker_docs now leaves them out).
const HISTORICAL = ['stockbit_03102026.md', 'stockbit_03102026_1.md', 'stockbit_05102026.md', 'stockbit_05102026_1.md'];
export function historicalAssets() {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'arsip-historical-')), 'assets');
  const run = spawnSync('python3', ['-B', path.join(ROOT, 'tests/helpers/worker_subset.py'), SITE, out, ...HISTORICAL], {encoding:'utf8'});
  if (run.status !== 0) throw new Error('worker_subset.py: ' + run.stderr);
  return out;
}
