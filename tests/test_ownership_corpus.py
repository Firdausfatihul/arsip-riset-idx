"""Cross-file invariants over the entire synced ownership corpus; no network or writes."""
import json
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'needtobeindexed' / 'idx-signal-desk'


class OwnershipCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((SOURCE / 'kepemilikan.json').read_text())
        cls.reports = json.loads((SOURCE / 'kepemilikan-laporan.json').read_text())

    def test_unique_issuers_aligned_dates_and_unique_investors_per_snapshot(self):
        months = [m['p'] for m in self.data['months']]
        self.assertEqual(months, sorted(set(months)))
        self.assertEqual(months, self.reports['months'])
        tickers = [c['t'] for c in self.data['companies']]
        self.assertEqual(len(tickers), len(set(tickers)))
        for c in self.data['companies']:
            for key in ['k', 'p', 'f', 'c', 'r']:
                self.assertEqual(len(c[key]), len(months), (c['t'], key))
            for i, k in enumerate(c['k']):
                if k is None:
                    continue
                ids = [r[0] for r in k['h']]
                self.assertEqual(len(ids), len(set(ids)), (c['t'], months[i]))

    def test_verified_ksei_aggregate_has_a_usable_source(self):
        for c in self.data['companies']:
            for i, p in enumerate(c['p']):
                if p is None or p[2] != 'K' or not p[1]:
                    continue
                k = c['k'][i]
                with self.subTest(ticker=c['t'], month=self.data['months'][i]['p']):
                    self.assertTrue(k and k['h'])
                    self.assertFalse(k.get('i'))
                    self.assertIsNotNone(k['tp'])
                    self.assertGreaterEqual(p[0], 0)
                    self.assertLessEqual(p[0], k['tp'] + 0.05)

    def test_trusted_snapshot_total_reconciles_to_holder_rows(self):
        for c in self.data['companies']:
            for i, k in enumerate(c['k']):
                if not k or not k['h'] or k.get('i'):
                    continue
                with self.subTest(ticker=c['t'], month=self.data['months'][i]['p']):
                    self.assertTrue(all(r[4] is not None for r in k['h']))
                    self.assertAlmostEqual(k['tp'], sum(r[4] for r in k['h']), delta=0.02)

    def test_repeated_report_names_do_not_claim_verified_pairing(self):
        for ticker, company in self.reports['companies'].items():
            for i, report in enumerate(company.get('d', [])):
                if not isinstance(report, dict):
                    continue
                grouped = {}
                for row in report['h']:
                    grouped.setdefault(row[0], []).append(row)
                for rows in grouped.values():
                    if len(rows) > 1:
                        self.assertTrue(all(row[4] == 0 for row in rows), (ticker, self.reports['months'][i]))


if __name__ == '__main__':
    unittest.main()
