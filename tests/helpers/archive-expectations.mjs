// Independent corpus checks: growing archives must not freeze old document counts.
import {readFile} from 'node:fs/promises';

export async function tickerDocuments(manifest, code) {
  const found = [], token = new RegExp('(?<![\\p{L}\\p{N}_])' + code + '(?![\\p{L}\\p{N}_])', 'u');
  for (const doc of manifest.docs) {
    const source = JSON.parse(await readFile(new URL('../../worker/.assets/' + doc.asset, import.meta.url), 'utf8'));
    if (token.test(source.search) || token.test(doc.title)) found.push(doc);
  }
  return found;
}

export function latestSourceDocuments(manifest, category) {
  const docs = manifest.docs.filter(d => d.cat === category);
  const latest = docs.map(d => d.end).sort().at(-1);
  return docs.filter(d => d.end === latest && !(d.name.endsWith('.csv') &&
    docs.some(other => other.end === d.end && other.name === d.name.replace(/\.csv$/, '.md'))));
}
