"""Evidence partitions: long lists and CSV rows become their own records; every split stays lossless."""
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import evidence_index as ev  # noqa: E402

TICKERS = {'BBCA', 'BBRI', 'TOWR', 'GRPM', 'HELI', 'SOCI', 'NINE'}


def evidence(body, kind='md', tickers=TICKERS):
    return ev.make_evidence({'body': body, 'kind': kind, 'path': 'files/x/y.' + kind, 'label': 'l', 'name': 'y'},
                            tickers)['records']


def item(code, n):
    return f'- {code} · {n} posting · ' + 'klaim pengguna belum diverifikasi ' * 6 + '\n'


class ListSplit(unittest.TestCase):
    def check(self, body, records):
        self.assertEqual(''.join(r['content'] for r in records), body)
        for r in records:
            self.assertEqual(body[r['start']:r['end']], r['content'])
            self.assertEqual(r['line'], body[:r['start']].count('\n') + 1)

    def test_long_list_outside_issuer_section_is_one_record_per_item(self):
        codes = ['BBCA', 'BBRI', 'TOWR', 'GRPM', 'HELI'] * 4
        body = '# Detail\n\n## Ikhtisar emiten\n\n' + ''.join(item(c, i) for i, c in enumerate(codes)) + '\n## Lain\n\nteks\n'
        records = evidence(body)
        self.check(body, records)
        items = [r for r in records if r['kind'] == 'list_item']
        self.assertEqual(len(items), len(codes))
        for r, code in zip(items, codes):
            self.assertEqual(r['tickers'], [code])
            self.assertEqual(r['context'], 'Detail\nIkhtisar emiten')
        self.assertTrue(items[-1]['content'].endswith('\n\n'))

    def test_short_list_stays_whole(self):
        body = '## Sorotan\n\n- BBCA naik\n- TOWR turun\n- GRPM ramai\n\nPenutup.\n'
        records = evidence(body)
        self.check(body, records)
        self.assertEqual([r['kind'] for r in records], ['context'] * 3)
        self.assertEqual(records[1]['tickers'], ['BBCA', 'GRPM', 'TOWR'])

    def test_continuation_and_nested_lines_stay_with_their_item(self):
        long = 'x' * 800
        body = ('## Lampiran\n\nPengantar tanpa baris kosong:\n'
                f'1. BBCA {long}\n   lanjutan BBCA\n   - sub BBRI\n2) TOWR {long}\nbaris malas TOWR\n* HELI\n+ GRPM\n')
        records = evidence(body)
        self.check(body, records)
        texts = [r['content'] for r in records]
        self.assertEqual(texts[1], 'Pengantar tanpa baris kosong:\n')
        self.assertEqual(records[1]['kind'], 'context')
        self.assertEqual(texts[2], f'1. BBCA {long}\n   lanjutan BBCA\n   - sub BBRI\n')
        self.assertEqual(records[2]['tickers'], ['BBCA', 'BBRI'])
        self.assertEqual(texts[3], f'2) TOWR {long}\nbaris malas TOWR\n')
        self.assertEqual([r['tickers'] for r in records[4:]], [['HELI'], ['GRPM']])
        self.assertEqual({r['kind'] for r in records[2:]}, {'list_item'})

    def test_issuer_section_stays_whole(self):
        body = '## TOWR\n\n' + ''.join(item(c, 1) for c in ['BBCA', 'GRPM'] * 10) + '\n## Penutup\n\nteks\n'
        records = evidence(body)
        self.check(body, records)
        self.assertEqual(records[0]['kind'], 'issuer_section')
        self.assertEqual(records[0]['tickers'], ['BBCA', 'GRPM', 'TOWR'])
        self.assertFalse(any(r['kind'] == 'list_item' for r in records))

    def test_footnote_definitions_split(self):
        body = '## Referensi sumber\n\n' + ''.join(
            f'[^{c}]: `{c} · ki` — bagian {c}, baris 1–2 pada file asli. ' + 'y' * 300 + '\n' for c in sorted(TICKERS))
        records = evidence(body)
        self.check(body, records)
        self.assertEqual([r['tickers'] for r in records[1:]], [[c] for c in sorted(TICKERS)])

    def test_table_header_does_not_leak_to_later_records(self):
        body = ('## Tabel\n\n| Kode | Isi |\n|---|---|\n| BBCA | a |\n\nParagraf BBRI.\n\n'
                '| Tanggal | Kode |\n|---|---|\n| 2026-10-01 | TOWR |\n')
        records = evidence(body)
        self.check(body, records)
        by_text = {r['content'].strip(): r for r in records}
        self.assertEqual(by_text['| BBCA | a |']['context'], 'Tabel\n| Kode | Isi |')
        self.assertEqual(by_text['Paragraf BBRI.']['context'], 'Tabel')
        row = by_text['| 2026-10-01 | TOWR |']
        self.assertEqual(row['context'], 'Tabel\n| Tanggal | Kode |')
        self.assertEqual(row['event_date'], '2026-10-01')

    def test_fenced_code_is_not_split_into_items(self):
        body = 'Contoh:\n```\n' + ''.join(f'- baris {i} BBCA ' + 'kode ' * 10 + '\n' for i in range(40)) + '```\n\nPenutup BBRI.\n'
        records = evidence(body)
        self.check(body, records)
        self.assertFalse(any(r['kind'] == 'list_item' for r in records))
        for r in records:
            self.assertEqual(r['content'].count('```') % 2, 0)

    def test_list_after_fence_still_splits(self):
        body = '## Lampiran\n\n```\n- kode BBCA\n```\n' + ''.join(item(c, i) for i, c in enumerate(['TOWR', 'GRPM'] * 8))
        records = evidence(body)
        self.check(body, records)
        items = [r for r in records if r['kind'] == 'list_item']
        self.assertEqual(len(items), 16)
        self.assertEqual(records[1]['content'], '```\n- kode BBCA\n```\n')

    def test_html_is_unchanged(self):
        body = '<h2>Daftar</h2>\n' + ''.join(f'- {c} ' + 'z' * 400 + '\n' for c in sorted(TICKERS))
        records = evidence(body, 'html')
        self.assertEqual(''.join(r['content'] for r in records), body)
        self.assertFalse(any(r['kind'] == 'list_item' for r in records))


class CsvRows(unittest.TestCase):
    def test_one_record_per_row_with_header_context(self):
        body = '﻿kode,nama,ringkasan\r\n11NB,NINE LTD,"baris\r\ndua ""kutip"""\r\nX1,BBCA TBK,biasa\r\nX2,tanpa,akhir'
        records = evidence(body, 'csv')
        self.assertEqual(''.join(r['content'] for r in records), body)
        self.assertEqual([r['content'] for r in records],
                         ['﻿kode,nama,ringkasan\r\n', '11NB,NINE LTD,"baris\r\ndua ""kutip"""\r\n',
                          'X1,BBCA TBK,biasa\r\n', 'X2,tanpa,akhir'])
        self.assertEqual([r['line'] for r in records], [1, 2, 4, 5])
        self.assertEqual([r['tickers'] for r in records], [[], ['NINE'], ['BBCA'], []])
        self.assertEqual({r['context'] for r in records}, {'\nkode,nama,ringkasan'})
        self.assertEqual({r['kind'] for r in records}, {'row'})

    def test_quote_inside_unquoted_cell_is_literal(self):
        # The viewer (csvHtml) opens a quoted cell only at the start of a cell; one inch mark must not merge rows.
        body = 'kode,desc,aksi\nBBCA,pipa 5" baja,rights issue\nBBRI,x,y\nTOWR,"a\nb",z\n'
        records = evidence(body, 'csv')
        self.assertEqual([r['tickers'] for r in records], [[], ['BBCA'], ['BBRI'], ['TOWR']])

    def test_bare_cr_and_semicolon_rows(self):
        body = 'kode;nama\rBBCA;"satu; dua"\rBBRI;tiga\r'
        records = evidence(body, 'csv')
        self.assertEqual([r['content'] for r in records], ['kode;nama\r', 'BBCA;"satu; dua"\r', 'BBRI;tiga\r'])


class RealArchive(unittest.TestCase):
    def test_every_markdown_and_csv_source_partitions_losslessly(self):
        source = ROOT / 'needtobeindexed'
        files = sorted(p for p in source.rglob('*') if p.suffix in ('.md', '.csv'))
        if not files:
            self.skipTest('needtobeindexed kosong')
        for path in files:
            body = path.read_bytes().decode('utf-8')
            tickers = set(re.findall(r'\b[A-Z]{4}\b', body))
            records = evidence(body, path.suffix[1:], tickers)  # make_evidence asserts losslessness itself
            self.assertEqual(records[-1]['end'] if records else 0, len(body), path.name)
            for r in records:
                self.assertEqual(body[r['start']:r['end']], r['content'], path.name)


if __name__ == '__main__':
    unittest.main()
