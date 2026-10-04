"""Issuer identity must not be inferred from a corporate-action abbreviation."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from event_index import classify, text_events


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


if __name__ == '__main__':
    unittest.main()
