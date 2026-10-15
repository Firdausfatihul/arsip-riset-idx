"""Lossless source partitions for issuer retrieval; no model, network, or source edits."""
import csv
import hashlib
import html
from html.parser import HTMLParser
import re

VERSION = 'issuer-passages-v3'
WORD = re.compile(r'\w+', re.UNICODE)
# Paragraphs split at blank lines; Markdown tables keep one record per row.
BLOCK = re.compile(r'\n\s*\n|(?<=\n)(?=\|)')
# A list item starts at column 0 ("- ", "* ", "+ ", "1. ", "1) ", footnote "[^KODE]:"); indented lines (nested items,
# continuations) stay with it. Blocks up to LIST_SPLIT characters stay whole: a short list is read as one unit,
# a long one (Ikhtisar emiten, Lampiran pengumuman) would tag one record with hundreds of tickers.
ITEM_START = re.compile(r'(?:[-*+]|\d{1,3}[.)])[ \t]+\S|\[\^[^\]\s]+\]:')
ITEM = re.compile(r'(?<=\n)(?=' + ITEM_START.pattern + ')')
LIST_SPLIT = 1500


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


def csv_delimiter(raw):
    """The delimiter the viewer uses (build.py): sniffed from the start, else from the header row, else a comma."""
    text = raw.lstrip('\ufeff')
    for sample in (text[:65536], text.split('\n', 1)[0]):
        try:
            return csv.Sniffer().sniff(sample, delimiters=',;\t').delimiter
        except csv.Error:
            pass
    return ','


def csv_rows(raw, delimiter=','):
    """Row ends outside quoted cells, as the viewer's csvHtml (build.py) parses them: a quote opens a quoted cell
    only at the start of a cell, "" inside it is an escaped quote, and a row ends at \\n, \\r or \\r\\n."""
    quoted, ends, cell_start, i, n = False, [], True, 0, len(raw)
    if raw.startswith('\ufeff'):
        i = 1
    while i < n:
        c = raw[i]
        if quoted:
            if c == '"':
                if raw[i + 1:i + 2] == '"':
                    i += 1
                else:
                    quoted = False
        elif c == '"' and cell_start:
            quoted = True
            cell_start = False
        elif c == delimiter:
            cell_start = True
        elif c in '\r\n':
            if c == '\r' and raw[i + 1:i + 2] == '\n':
                i += 1
            ends.append(i + 1)
            cell_start = True
        else:
            cell_start = False
        i += 1
    return ends


def fence_spans(text):
    """[start, end) spans of fenced code blocks (column-0 ``` or ~~~ up to the matching closing fence)."""
    spans, opened = [], None
    for m in re.finditer(r'(?m)^(`{3,}|~{3,})[^\n]*$', text):
        if opened is None:
            opened = m
        elif m[1][0] == opened[1][0] and len(m[1]) >= len(opened[1]) and not m.group(0)[len(m[1]):].strip():
            spans.append((opened.start(), m.end()))
            opened = None
    if opened is not None:
        spans.append((opened.start(), len(text)))
    return spans


def partitions(raw, kind, tickers):
    if kind == 'csv':
        # One record per CSV row, like Markdown table rows; the header row is carried as context.
        bounds = [0] + csv_rows(raw, csv_delimiter(raw)) + [len(raw)]
        for a, b in zip(bounds, bounds[1:]):
            if b > a:
                yield a, b, 'row'
        return
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
            boundaries = [0] + [m.end() for m in BLOCK.finditer(gap)] + [len(gap)]
            fences = fence_spans(gap) if kind == 'md' else []
            for left, right in zip(boundaries, boundaries[1:]):
                # A "- " line inside a fenced code block is code, not a list item: the fence stays in one record.
                items = ([m.start() for m in ITEM.finditer(gap, left + 1, right)
                          if not any(a < m.start() < b for a, b in fences)]
                         if kind == 'md' and right - left > LIST_SPLIT else [])
                # Long lists retain individual items, tagged with their own tickers only.
                for a, b in zip([left] + items, items + [right]):
                    if b > a:
                        yield cursor + a, cursor + b, 'list_item' if items and ITEM_START.match(gap, a) else 'context'
        if end > start:
            yield start, end, record_kind
        cursor = end


def make_evidence(doc, tickers):
    raw = doc['body']
    records, headings, table_header, line, previous = [], [], '', 1, 0
    for start, end, kind in partitions(raw, doc['kind'], tickers):
        text = raw[start:end]
        line, previous = line + raw.count('\n', previous, start), start
        if kind == 'row' and not records:
            table_header = text.strip().lstrip('\ufeff')
        heading = (re.match(r'^(#{1,6})\s+([^\n]+)', text) if doc['kind'] == 'md'
                   else re.match(r'<h([1-6])\b[^>]*>(.*?)</h\1>', text, re.S | re.I))
        if heading:
            level = len(heading[1]) if doc['kind'] == 'md' else int(heading[1])
            headings = [(n, h) for n, h in headings if n < level] + [(level, heading[2])]
            table_header = ''
        if (kind == 'tr' and re.search(r'<th\b', text, re.I)) or (
            doc['kind'] == 'md' and text.lstrip().startswith('|') and not table_header):
            table_header = text.strip()
        elif doc['kind'] == 'md' and text.strip() and not text.lstrip().startswith('|'):
            # A table ends at the first non-row record; later paragraphs/items and the next table do not
            # inherit its header (each list item would repeat it).
            table_header = ''
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
                        'start': start, 'end': end, 'line': line,
                        'kind': kind, 'tickers': codes, 'event_date': event_date,
                        'dates_mentioned': sorted(set(re.findall(r'\b20\d{2}-\d{2}-\d{2}\b', plain))),
                        'context': '\n'.join(h for _, h in headings) + ('\n' + table_header if table_header else ''),
                        'content': text})
    assert ''.join(r['content'] for r in records) == raw, doc['name']
    return {'version': VERSION, 'document_id': digest(doc['path']), 'document_hash': digest(raw),
            'source_path': doc['path'], 'document_date': doc['label'],
            'exchange': 'ASX' if 'australia' in doc['path'] else 'SGX' if 'singapura' in doc['path'] else 'IDX',
            'coverage': 'full-source-partition', 'records': records}
