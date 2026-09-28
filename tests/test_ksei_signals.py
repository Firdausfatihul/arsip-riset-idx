"""KSEI signal layer on the real kepemilikan.json (no network). Facts checked by hand against the KSEI rows."""
import json, pathlib, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import ksei_signals  # noqa: E402

SOURCE = ROOT / 'needtobeindexed' / 'idx-signal-desk' / 'kepemilikan.json'


@unittest.skipUnless(SOURCE.exists(), 'kepemilikan.json not synced')
class KseiSignals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signals, cls.history = ksei_signals.build(json.loads(SOURCE.read_text(encoding='utf-8')))

    def of(self, ticker, kind):
        return [s for s in self.signals['issuers'].get(ticker, {}).get('signals', []) if s['k'] == kind]

    def test_split_of_a_controller_block_into_new_holders(self):
        split = next(s for s in self.of('LUCY', 'split') if s['m'] == '2026-06')
        self.assertEqual(split['shares'], 378693473)
        self.assertIn(['PT SENTOSA BERSAMA MITRA', 75000000], split['to'])
        self.assertTrue(any(shares == 71069516 for _, shares in split['to']))
        self.assertIn('bukan bukti', split['kalimat'])

    def test_seller_matched_to_new_holders(self):
        split = next(s for s in self.of('HELI', 'split') if s['m'] == '2026-03')
        self.assertIn(['PT. ALTA INTERNASIONAL INDONESIA', 133258000], split['to'])
        self.assertIn(['PT. Anugerah Bumiputra', 22500000], split['to'])

    def test_exact_transfers_and_tiers(self):
        asli = next(s for s in self.of('ASLI', 'transfer') if s['shares'] == 732500000)
        self.assertTrue(asli['exact'])
        self.assertEqual(asli['tier'], 'sedang', 'round lot')
        flmc = next(s for s in self.of('FLMC', 'transfer') if s['shares'] == 45177321)
        self.assertEqual((flmc['to'], flmc['tier']), ('HANS SAPUTRA', 'kuat'))
        brrc = next(s for s in self.of('BRRC', 'split') if s['m'] == '2026-08')
        self.assertEqual(sorted(x for _, x in brrc['to']), [21588700, 21588700])
        self.assertEqual(brrc['tier'], 'kuat')

    def test_word_order_variant_is_one_holder_not_an_exit(self):
        meja = self.signals['issuers'].get('MEJA', {}).get('signals', [])
        self.assertFalse([s for s in meja if s['k'] in ('new', 'exit') and 'TRIPLE' in s['who'].upper()])

    def test_renames_detected_and_custodians_excluded(self):
        pairs = {(r['old'], r['new']) for r in self.signals['renames']}
        self.assertIn(('PT BASIS UTAMA PRIMA', 'PT TIRTA ORISA YASA'), pairs)
        self.assertIn(('PT MAJUKARYA MANDIRI INDONESIA', 'NUSANTARA ENERGI BERSIH, PT'), pairs)
        for r in self.signals['renames']:
            for name in (r['old'], r['new']):
                self.assertFalse(ksei_signals.custodian(name, ''), name)

    def test_clusters_compared_with_the_largest_holder(self):
        self.assertGreater(self.of('BOGA', 'cluster')[0]['vs_top'], 0)
        self.assertGreater(self.of('EURO', 'cluster')[0]['vs_top'], 0)
        self.assertAlmostEqual(self.of('ARKO', 'cluster')[0]['total'], 8.25, delta=0.05)
        self.assertIn('bukan bukti bertindak bersama', self.of('ARKO', 'cluster')[0]['kalimat'])

    def test_party_index_and_history(self):
        party = self.signals['parties'][ksei_signals.tokkey('PT TRIPLE BERSAMA BERKAH')]
        self.assertTrue({'EPAC', 'MEJA'} <= {row[0] for row in party['series']})
        holders = self.history['issuers']['MEJA']['holders']
        triple = [h for h in holders if 'TRIPLE' in h['name'].upper()]
        self.assertEqual(len(triple), 1, 'variants merged into one series')

    def test_sizes_and_determinism(self):
        again, _ = ksei_signals.build(json.loads(SOURCE.read_text(encoding='utf-8')))
        self.assertEqual(json.dumps(again, sort_keys=True), json.dumps(self.signals, sort_keys=True))
        self.assertLess(len(json.dumps(self.signals, ensure_ascii=False)), 5_000_000)
        self.assertEqual(len(self.signals['leaderboard']), 50)


if __name__ == '__main__':
    unittest.main()
