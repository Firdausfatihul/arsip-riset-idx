"""Issuer identity must not be inferred from a corporate-action abbreviation."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from event_index import classify, text_events, make_events, without_csv_twins


class EventIdentityTests(unittest.TestCase):
    def events(self, sentence):
        return text_events({'cat': 'stockbit', 'kind': 'md', 'start': '2026-10-01',
                            'end': '2026-10-01', 'source_id': 'D1'},
                           {'KBLI', 'SOFA'}, [{'content': sentence, 'line': 1}])

    def test_later_industry_code_is_not_a_company(self):
        text = 'Rencana penambahan kegiatan usaha KBLI 64220 (Aktivitas Pembiayaan Conduit)'
        self.assertEqual(self.events(text), [])
        terms = set()
        self.assertEqual(classify(text, terms), ['business_change'])
        self.assertIn('KBLI', terms)

    def test_named_company_keeps_its_business_change(self):
        events = self.events('SOFA: rencana penambahan kegiatan usaha KBLI 64220.')
        self.assertEqual([(e['ticker'], e['type']) for e in events], [('SOFA', 'business_change')])

    def test_explicit_kbli_issuer_is_preserved(self):
        events = self.events('PT KMI Wire and Cable Tbk (KBLI) melakukan penambahan kegiatan usaha.')
        self.assertEqual([(e['ticker'], e['type']) for e in events], [('KBLI', 'business_change')])

    def test_negated_then_positive_clause_only_once(self):
        self.assertEqual(classify('Tidak ada rights issue; SOFA mengumumkan rights issue dan HMETD.'), ['rights_issue'])


class CsvTwinTests(unittest.TestCase):
    """A CSV with a Markdown twin is read by chat only as Markdown; events must not count it twice."""

    def doc(self, source_id, name, body, cat='keterbukaan-singapura', end='2026-09-20'):
        return {'source_id': source_id, 'name': name, 'cat': cat, 'kind': name.rsplit('.', 1)[1],
                'start': end, 'end': end, 'title': name, 'body': body}

    def test_twin_csv_is_skipped_but_lone_csv_and_other_dates_are_kept(self):
        row = 'SOFA, PT Sofa Indah Tbk (SOFA), rights issue HMETD'
        md = self.doc('D1', 'keterbukaan_sg_20092026_semua_kode.md', row)
        twin = self.doc('D2', 'keterbukaan_sg_20092026_semua_kode.csv', row)
        lone = self.doc('D3', 'keterbukaan_sg_20092026_lain.csv', row)
        other_day = self.doc('D4', 'keterbukaan_sg_20092026_semua_kode.csv', row, end='2026-09-21')
        other_cat = self.doc('D5', 'keterbukaan_sg_20092026_semua_kode.csv', row, cat='lainnya')
        docs = [md, twin, lone, other_day, other_cat]
        self.assertEqual([d['source_id'] for d in without_csv_twins(docs)], ['D1', 'D3', 'D4', 'D5'])
        evidence = {d['source_id']: {'records': [{'content': row, 'line': 1}]} for d in docs}
        result = make_events(docs, {'SOFA'}, evidence)
        self.assertEqual(sorted(e['source_id'] for e in result['events']), ['D1', 'D3', 'D4', 'D5'])
        self.assertEqual(result['names'], {'SOFA': 'PT Sofa Indah Tbk'})
        # Names: the twin is skipped in name_docs as well, so the count is not inflated by the duplicate.
        counts_docs = [md, twin]
        self.assertEqual(make_events(counts_docs, {'SOFA'}, evidence, name_docs=counts_docs)['events'][0]['source_id'], 'D1')
        self.assertEqual(len(make_events(counts_docs, {'SOFA'}, evidence)['events']), 1)

    def test_csv_alone_still_yields_events(self):
        csv = self.doc('D2', 'keterbukaan_sg_20092026_semua_kode.csv', 'SOFA rights issue HMETD')
        result = make_events([csv], {'SOFA'}, {'D2': {'records': [{'content': 'SOFA rights issue HMETD', 'line': 2}]}})
        self.assertEqual([(e['ticker'], e['type'], e['source_id']) for e in result['events']], [('SOFA', 'rights_issue', 'D2')])


if __name__ == '__main__':
    unittest.main()
