import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {documentUnits} from '../worker/document-material.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const asset = async name => JSON.parse(await readFile(new URL('../worker/.assets/' + name, import.meta.url), 'utf8'));

function verify(doc, records, original) {
  const units = documentUnits(doc, records), parts = units.flatMap(unit => unit.parts);
  assert.equal(parts.map(part => part.text).join(''), original, doc.name);
  let offset = 0, line = 1, rowIndex = 0;
  let rowEnd = Array.from(records[0]?.content || '').length;
  for (const unit of units) {
    assert.equal(unit.doc, doc);
    assert.ok(bytes(unit.parts) <= 220000, doc.name);
  }
  for (const part of parts) {
    while (rowEnd <= offset && rowIndex < records.length - 1) {
      rowEnd += Array.from(records[++rowIndex].content).length;
    }
    assert.equal(part.source_id, 'D1');
    assert.equal(part.source_start, offset);
    assert.equal(part.source_line, line);
    assert.equal(part.section_id, records[rowIndex].section_id);
    assert.equal(part.context, records[rowIndex].context || '');
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.text), 'No dangling high surrogate');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text), 'No dangling low surrogate');
    offset += Array.from(part.text).length;
    line += (part.text.match(/\n/g) || []).length;
    assert.equal(part.source_end, offset);
  }
  return units;
}

test('empty documents have no units; source records are not mutated', () => {
  assert.deepEqual(documentUnits({}, []), []);
  const row = Object.freeze({section_id:'section-1', context:'Title', content:'# Title\n\nContent.'});
  verify({}, Object.freeze([row]), row.content);
});

test('Unicode, lines and source offsets remain exact across long record boundaries', () => {
  const records = [
    {section_id:'a', context:'First heading', content:'x'.repeat(21999) + '😀\n'},
    {section_id:'b', context:'Next heading', content:('é中😀\r\n').repeat(15000)},
    {section_id:'c', context:'Last heading', content:'\nFinal source line.'}
  ];
  verify({}, records, records.map(row => row.content).join(''));
});

test('table headers and section headings follow the source at every chunk boundary', () => {
  const heading = '# Source\n\n## Holdings\n\n', header = '| Holder | Shares |\n';
  const records = [
    {section_id:'heading', context:'Source\nHoldings', content:heading},
    {section_id:'header', context:'Source\nHoldings\n' + header.trim(), content:header},
    ...Array.from({length:5000}, (_, i) => ({
      section_id:'holder-' + i, context:'Source\nHoldings\n' + header.trim(),
      content:`| Holder ${i} | ${i + 1} |\n`
    })),
    {section_id:'next', context:'Source\nOther section', content:'\n## Other section\n\n' + 'Another fact. '.repeat(3000)}
  ];
  const units = verify({}, records, records.map(row => row.content).join(''));
  const parts = units.flatMap(unit => unit.parts);
  assert.ok(parts.some(part => part.section_id.startsWith('holder-')));
  for (const part of parts.filter(part => part.section_id.startsWith('holder-'))) {
    assert.equal(part.context, 'Source\nHoldings\n' + header.trim());
  }
  assert.ok(parts.some(part => part.context === 'Source\nOther section'));
  assert.ok(parts.length < records.length / 100, 'Context is repeated per chunk, not per table row');
});

test('all current archive documents preserve original text, hashes, offsets and context', async () => {
  const manifest = await asset('manifest.json');
  for (const doc of manifest.docs) {
    const evidence = await asset(doc.evidence_asset), original = await asset(doc.asset);
    const source = original.parts.map(part => part.text).join('');
    const units = verify(doc, evidence.records, source);
    assert.equal(sha256(units.flatMap(unit => unit.parts).map(part => part.text).join('')), doc.document_hash, doc.name);
  }
});

test('historical three Stockbit sources from 3–5 October retain every character within five note units', async () => {
  const manifest = await asset('manifest.json');
  const names = ['stockbit_03102026.md', 'stockbit_05102026.md', 'stockbit_05102026_1.md'];
  const docs = manifest.docs.filter(doc => names.includes(doc.name));
  assert.equal(docs.length, 3, 'Regression sources must be present');
  let selectedBytes = 0, notes = 0;
  for (const doc of docs) {
    const evidence = await asset(doc.evidence_asset);
    const units = verify(doc, evidence.records, evidence.records.map(row => row.content).join(''));
    selectedBytes += units.reduce((sum, unit) => sum + bytes(unit.parts), 0);
    notes += units.filter(unit => bytes(unit.parts) > 24000).length;
  }
  assert.ok(selectedBytes < 880000, `${selectedBytes} prompt bytes`);
  assert.ok(notes <= 5, `${notes} note units`);
});
