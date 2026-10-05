// Whole-document prompts retain every source character without repeating the
// retrieval index's headings and table headers for every paragraph/table row.
// Offsets count Unicode code points, matching tools/evidence_index.py.
const encoder = new TextEncoder();
const bytes = value => encoder.encode(JSON.stringify(value)).length;
const UNIT_LIMIT = 220000;
const PART_LENGTH = 22000;

export function documentUnits(doc, records) {
  const text = records.map(row => row.content).join('');
  const units = [];
  let parts = [], unitBytes = 2, rowIndex = 0, rowEnd = records[0]?.content.length || 0;
  let sourceLine = 1, sourceOffset = 0, part = 0;
  for (let start = 0; start < text.length;) {
    while (rowEnd <= start && rowIndex < records.length - 1) {
      rowEnd += records[++rowIndex].content.length;
    }
    const row = records[rowIndex];
    let end = Math.min(start + PART_LENGTH, text.length);
    // Never separate the two UTF-16 code units of a source character.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const content = text.slice(start, end);
    const nextOffset = sourceOffset + Array.from(content).length;
    const value = {
      source_id: 'D1', section_id: row.section_id, source_line: sourceLine,
      source_start: sourceOffset, source_end: nextOffset,
      // Context is needed when a chunk starts inside a section or table. Other
      // headings and headers are already present in the unmodified source text.
      context: row.context || '', part: ++part, text: content
    };
    const partBytes = bytes(value);
    if (partBytes + 2 > UNIT_LIMIT) throw new Error('Document source context exceeds the material limit.');
    if (parts.length && unitBytes + 1 + partBytes > UNIT_LIMIT) {
      units.push({doc, parts});
      parts = []; unitBytes = 2;
    }
    unitBytes += partBytes + (parts.length ? 1 : 0);
    parts.push(value);
    sourceLine += (content.match(/\n/g) || []).length;
    sourceOffset = nextOffset;
    start = end;
  }
  if (parts.length) units.push({doc, parts});
  return units;
}
