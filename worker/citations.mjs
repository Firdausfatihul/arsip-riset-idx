// Keep source validation consistent for answers, screening summaries and evaluators.
// The viewer accepts individual, grouped and bounded range references.
export function citations(text) {
  const out = [];
  for (const m of text.matchAll(/\[((?:[DKO]\d+)(?:\s*(?:,|;|-|–)\s*[DKO]?\d+)*)\]/g)) {
    for (const part of m[1].split(/\s*[,;]\s*/)) {
      const range = part.match(/^([DKO])(\d+)\s*[-–]\s*[DKO]?(\d+)$/);
      if (range) for (let n = +range[2]; n <= Math.min(+range[3], +range[2] + 30); n++) out.push(range[1] + n);
      else if (/^[DKO]\d+$/.test(part)) out.push(part);
    }
  }
  return out;
}
