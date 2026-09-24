"""Lossless source partitions for issuer retrieval; no model, network, or source edits."""
import hashlib
import html
from html.parser import HTMLParser
import re

VERSION = 'issuer-passages-v2'
WORD = re.compile(r'\w+', re.UNICODE)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Records(HTMLParser):
    """Locate complete records in original HTML, retaining scripts as data blocks."""
    TAGS = {'article', 'tr', 'p', 'li', 'script', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}

    def __init__(self, raw):
        super().__init__(convert_charrefs=False)
        self.raw, self.ranges, self.active = raw, [], None
        self.lines = [0] + [m.end() for m in re.finditer('\n', raw)]

    def position(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        if self.active:
            if tag == self.active[0]:
                self.active[2] += 1
        elif tag in self.TAGS:
            self.active = [tag, self.position(), 1]

    def handle_endtag(self, tag):
        if self.active and tag == self.active[0]:
            self.active[2] -= 1
            if not self.active[2]:
                end = self.raw.find('>', self.position())
                self.ranges.append((self.active[1], end + 1, tag))
                self.active = None


def heading_ticker(title, tickers):
    title = re.sub(r'^[\d.()\s]+', '', title.replace('*', '').replace('`', ''))
    match = re.match(r'([A-Z0-9]{2,8})(?=\W|$)', title)
    return match[1] if match and match[1] in tickers else None


def markdown_ranges(raw, tickers):
    headings = list(re.finditer(r'^(#{1,6})\s+(.+)$', raw, re.M))
    ranges, until = [], 0
    for i, match in enumerate(headings):
        if match.start() < until or not heading_ticker(match[2], tickers):
            continue
        end = next((h.start() for h in headings[i + 1:] if len(h[1]) <= len(match[1])), len(raw))
        ranges.append((match.start(), end, 'issuer_section'))
        until = end
    return ranges


def partitions(raw, kind, tickers):
    if kind == 'html':
        parser = Records(raw)
        parser.feed(raw)
        ranges = parser.ranges
    else:
        ranges = markdown_ranges(raw, tickers)
    cursor = 0
    for start, end, record_kind in ranges + [(len(raw), len(raw), 'end')]:
        if start > cursor:
            gap = raw[cursor:start]
            # Markdown tables retain individual rows. Context carries their header below.
            boundaries = [0] + [m.end() for m in re.finditer(r'\n\s*\n|(?<=\n)(?=\|)', gap)] + [len(gap)]
            for left, right in zip(boundaries, boundaries[1:]):
                if right > left:
                    yield cursor + left, cursor + right, 'context'
        if end > start:
            yield start, end, record_kind
        cursor = end


def make_evidence(doc, tickers):
    raw = doc['body']
    records, headings, table_header = [], [], ''
    for start, end, kind in partitions(raw, doc['kind'], tickers):
        text = raw[start:end]
        heading = (re.match(r'^(#{1,6})\s+([^\n]+)', text) if doc['kind'] == 'md'
                   else re.match(r'<h([1-6])\b[^>]*>(.*?)</h\1>', text, re.S | re.I))
        if heading:
            level = len(heading[1]) if doc['kind'] == 'md' else int(heading[1])
            headings = [(n, h) for n, h in headings if n < level] + [(level, heading[2])]
            table_header = ''
        if (kind == 'tr' and re.search(r'<th\b', text, re.I)) or (
            doc['kind'] == 'md' and text.lstrip().startswith('|') and not table_header):
            table_header = text.strip()
        if '</table' in text.lower():
            table_header = ''
        # Tickers are tagged only when written in capitals: NAIK, TRUE, GOLD are also ordinary words.
        codes = sorted(set(w for w in WORD.findall(html.unescape(text)) if w.isupper()) & tickers)
        plain = html.unescape(re.sub('<[^>]+>', ' ', text)) if doc['kind'] == 'html' else text
        # Only an ISO date at the beginning of a record is classified as its event date.
        # Other dates are mentions, never mistaken for an event/publication date.
        first = re.match(r'^\s*\|?\s*(20\d{2}-\d{2}-\d{2})(?=[ T|\s]|$)', plain)
        event_date = first[1] if first and (kind == 'tr' or text.lstrip().startswith('|')) else None
        records.append({'section_id': digest(text)[:24] + '-' + str(start),
                        'start': start, 'end': end, 'line': raw[:start].count('\n') + 1,
                        'kind': kind, 'tickers': codes, 'event_date': event_date,
                        'dates_mentioned': sorted(set(re.findall(r'\b20\d{2}-\d{2}-\d{2}\b', plain))),
                        'context': '\n'.join(h for _, h in headings) + ('\n' + table_header if table_header else ''),
                        'content': text})
    assert ''.join(r['content'] for r in records) == raw, doc['name']
    return {'version': VERSION, 'document_id': digest(doc['path']), 'document_hash': digest(raw),
            'source_path': doc['path'], 'document_date': doc['label'],
            'exchange': 'ASX' if 'australia' in doc['path'] else 'SGX' if 'singapura' in doc['path'] else 'IDX',
            'coverage': 'full-source-partition', 'records': records}
