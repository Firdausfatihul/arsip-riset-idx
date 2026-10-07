"""Regression fixtures for investor identity, source trust, and ownership-only sync; no network."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import sync_idx as sync


def group(name, total=100, pct=10):
    return {"name": name, "total": total, "pct": pct, "rows": 1, "cls": "", "lf": ""}


def holder(name, shares, pct, validation="ok", roles=None):
    return {"name": name, "shares": shares, "pct": pct, "validation": validation,
            "roles": roles or ["shareholder_5plus"]}


def snapshot(holders, public=0, total=1000):
    return {"validation": "ok", "issues": [], "holders": holders,
            "metrics": {key: {"value": value, "validation": "ok"} for key, value in {
                "total_shares": total, "public_under5_scrip": 0,
                "public_under5_scripless": public, "treasury_shares": 0}.items()}}


class InvestorIdentityTests(unittest.TestCase):
    def test_lkh_shares_may_change_with_name_order_and_honorific(self):
        history = {}
        feb = {"old": group("LO KHENG HONG. DRS", 154835300, 5.62)}
        mar = {"new": group("DRS LO KHENG HONG", 155382400, 5.64)}
        self.assertEqual(sync.assign_investor_ids(feb, history), [])
        self.assertEqual(sync.assign_investor_ids(mar, history), [])
        self.assertEqual(feb["old"]["inv"], mar["new"]["inv"])
        self.assertEqual(mar["new"]["total"] - feb["old"]["total"], 547100)
        self.assertEqual(sync.match_renamed(mar, feb), {"new": feb["old"]})

    def test_meja_order_and_uob_legal_suffixes_are_equivalent(self):
        self.assertTrue(sync.same_investor("PT TRIPLE BERKAH BERSAMA", "PT TRIPLE BERSAMA BERKAH"))
        self.assertTrue(sync.same_investor("UOB KAY HIAN PRIVATE LIMITED", "UOB KAY HIAN PTE LTD"))

    def test_partial_names_typos_and_account_ids_are_not_merged(self):
        for a, b in [("PT ALPHA", "PT ALPHA INVESTAMA"), ("ANDI WIJAYA", "ANDI WIJAYA SANTOSO"),
                     ("BANK X A/C 123", "BANK X A/C 456"), ("BANK X ACCOUNT A B", "BANK X ACCOUNT B A"),
                     ("UOB KAY HIAN PRIVATE LIMITED", "UOB KAY HIAN PRIVATE LIMITED A/C CLIENT"),
                     ("TASPEN", "TASPENNA")]:
            with self.subTest(a=a, b=b):
                self.assertFalse(sync.same_investor(a, b))
                self.assertEqual(sync.match_renamed({"new": group(b)}, {"old": group(a)}), {})

    def test_ambiguous_many_to_one_is_not_arbitrarily_matched(self):
        old = {"a": group("PT TASPEN"), "b": group("TASPEN (PERSERO)")}
        self.assertEqual(sync.match_renamed({"new": group("TASPEN")}, old), {})
        history = {}
        issues = sync.assign_investor_ids(old, history)
        new = {"new": group("TASPEN")}
        self.assertEqual(len(issues), 2)
        self.assertTrue(sync.assign_investor_ids(new, history))
        self.assertNotIn(new["new"]["inv"], {old["a"]["inv"], old["b"]["inv"]})

    def test_alias_reappears_after_gap_without_id_collision(self):
        history = {}
        original = {"a": group("PT TASPEN")}
        renamed = {"b": group("TASPEN (PERSERO)", 105)}
        sync.assign_investor_ids(original, history)
        sync.assign_investor_ids(renamed, history)
        sync.assign_investor_ids({}, history)
        returned = {"a": group("PT TASPEN", 110)}
        self.assertEqual(sync.assign_investor_ids(returned, history), [])
        self.assertEqual(original["a"]["inv"], returned["a"]["inv"])
        simultaneous = {"a": group("PT TASPEN", 110), "b": group("TASPEN (PERSERO)", 120)}
        self.assertTrue(sync.assign_investor_ids(simultaneous, history))
        self.assertEqual(len({row["inv"] for row in simultaneous.values()}), 2)
        subsequent = {"a": group("PT TASPEN", 111), "b": group("TASPEN (PERSERO)", 121),
                      "c": group("UNRELATED", 10)}
        sync.assign_investor_ids(subsequent, history)
        self.assertEqual(len({row["inv"] for row in subsequent.values()}), 3)
        after_ambiguity = {"a": group("PT TASPEN", 130)}
        self.assertTrue(sync.assign_investor_ids(after_ambiguity, history),
                        "nonadjacent comparison must remain blocked after identity split")
        self.assertNotEqual(original["a"]["inv"], after_ambiguity["a"]["inv"])

    def test_ids_do_not_depend_on_input_order(self):
        a = {"z": group("ZEUS"), "a": group("ALPHA")}
        b = dict(reversed(list(a.items())))
        sync.assign_investor_ids(a, {})
        expected = {key: row["inv"] for key, row in a.items()}
        sync.assign_investor_ids(b, {})
        self.assertEqual(expected, {key: row["inv"] for key, row in b.items()})


class OwnershipTrustTests(unittest.TestCase):
    def test_ksei_issue_invalidates_aggregate_even_if_upstream_flags_ok(self):
        cur = {"total_pct": 60, "validation": "ok", "holders": [{"pct": 60, "validation": "ok"}]}
        self.assertTrue(sync.ksei_ok(cur))
        cur["issues"] = ["duplicate_investor_key:PT ALPHA"]
        self.assertFalse(sync.ksei_ok(cur))
        self.assertEqual(sync.ksei_block(cur), (60, 0))

    def test_affiliation_subtotal_is_not_an_individual_blockholder(self):
        source = snapshot([holder("PT ALPHA", 600, 60), holder("Afiliasi", 180, 18),
                           holder("DIREKTUR", 20, 2, roles=["director"])], public=200)
        self.assertEqual(sync.blockholders(source, True), (60, 0))
        rows = sync.report_holders(source, lambda name: name)["h"]
        self.assertEqual(next(row for row in rows if row[0] == "Afiliasi"), ["Afiliasi", 1, 180, 18, 0, 2])
        self.assertEqual(next(row for row in rows if row[0] == "PT ALPHA"), ["PT ALPHA", 1, 600, 60, 1, 1])
        self.assertEqual(source["holders"][1]["shares"], 180, "raw shares must be preserved")

    def test_derivable_only_for_role_and_missing_total_issues(self):
        def review(issues, **extra):
            return dict({"validation": "review", "issues": issues, "holders": [holder("PT ALPHA", 600, 60, "review", ["shareholder_5plus", "unknown"])]}, **extra)
        ok = review(["holder_needs_review:PT ALPHA", "required_metric_missing:total_shares"])
        self.assertTrue(sync.derivable(ok, [ok]))
        # Server conflict can come from other metrics; agreeing holder numbers stay usable.
        self.assertTrue(sync.derivable(ok, [ok, dict(ok, metrics={"free_float_pct": {"value": 12}})]))
        other = dict(ok, holders=[holder("PT ALPHA", 500, 50)])
        self.assertFalse(sync.derivable(ok, [ok, other]), "versions disagree on holder numbers")
        extra = dict(ok, holders=ok["holders"] + [holder("DIREKTUR", 10, 1, roles=["director"]), holder("Total Pengendali", None, 60)])
        self.assertTrue(sync.derivable(ok, [ok, extra]), "rows present in one version only are not contradictions")
        totals = [dict(ok, metrics={"total_shares": {"value": n}}) for n in (1000, 5000)]
        self.assertFalse(sync.derivable(ok, [ok] + totals), "written total shares disagree")
        for bad in ("holder_percentage_mismatch:PT ALPHA", "conflicting_holder:PT ALPHA", "report_period_implausible:x",
                    "issuer_mismatch:ABCD", "holder_headers_unverified:page2", "invalid_numeric_cell:page3"):
            self.assertFalse(sync.derivable(review([bad]), []), bad)
        self.assertFalse(sync.derivable(review([], import_status="quarantined"), []))
        listed = sync.report_holders(ok, lambda name: name, trusted=False, usable=True)
        self.assertEqual(listed["v"], 1)
        self.assertEqual(listed["h"][0][4:], [0, 1])
        self.assertEqual(sync.report_holders(ok, lambda name: name, trusted=False)["v"], 0)
        # comparable() is not enough: v follows derivable() only.
        self.assertEqual(sync.report_holders(ok, lambda name: name, trusted=True, usable=False)["v"], 0)

    def test_row_named_by_non_derivable_issue_is_not_derivable(self):
        source = snapshot([holder("PT ALPHA", 600, 60), holder("PT BETA", 937, 9.37, "review"), holder("PT ALPHA", 10, 1)])
        source["issues"] = ["holder_percentage_mismatch:PT BETA"]
        source["holders"].append(holder("PT GAMMA", 100, 10))
        rows = {r[0]: r for r in sync.report_holders(source, lambda name: name)["h"]}
        self.assertEqual(rows["PT BETA"][5], 0)
        self.assertEqual(rows["PT ALPHA"][5], 0, "duplicate name")
        self.assertEqual(rows["PT GAMMA"][5], 1)

    def test_clean_verified_snapshot_uses_actual_five_percent_threshold(self):
        source = snapshot([holder("PT ALPHA", 600, 60), holder("AFFILIATE NAMED", 20, 2)], public=380)
        self.assertEqual(sync.blockholders(source, True), (60, 1))
        self.assertEqual(sync.blockholders(source, False), (60, 0))

    def test_duplicate_and_invalid_holder_rows_cannot_be_verified(self):
        duplicate = snapshot([holder("PT ALPHA", 200, 20), holder("ALPHA PT", 100, 10)], public=700)
        self.assertEqual(sync.blockholders(duplicate, True), (30, 0))
        rows = sync.report_holders(duplicate, lambda name: name)["h"]
        self.assertEqual([row[4] for row in rows], [0, 0])
        self.assertEqual(sorted(row[2] for row in rows), [100, 200])
        invalid = snapshot([holder("PT ALPHA", 600, 60, validation="needs_review")], public=400)
        self.assertEqual(sync.blockholders(invalid, True), (60, 0))
        self.assertEqual(sync.report_holders(invalid, lambda name: name)["h"][0][4], 0)
        clean = snapshot([holder("PT ALPHA", 600, 60)], public=400)
        self.assertEqual(sync.report_holders(clean, lambda name: name, trusted=False)["h"][0][4], 0)

    def test_written_estimate_rejects_blocked_conflicting_or_duplicate_sources(self):
        source = snapshot([holder("PT ALPHA", 600, 60)])
        source["metrics"].pop("total_shares")
        self.assertEqual(sync.written_blockholders(source), 60)
        self.assertIsNone(sync.written_blockholders(source, conflict=True))
        for field, value in [("import_status", "quarantined"), ("import_status", "previous_parse_retained"),
                             ("issues", ["issuer_mismatch:OTHER"]), ("issues", ["source_refresh_degraded:failed"])]:
            with self.subTest(field=field, value=value):
                self.assertIsNone(sync.written_blockholders({**source, field: value}))
        duplicate = {**source, "holders": [holder("PT ALPHA", 600, 60), holder("ALPHA PT", 200, 20)]}
        self.assertIsNone(sync.written_blockholders(duplicate))

    def test_compact_export_keeps_identity_and_propagates_ambiguity(self):
        periods = []
        for month, rows in [("2026-02", [("old", "LO KHENG HONG. DRS", 154835300, 5.62)]),
                            ("2026-03", [("new", "DRS LO KHENG HONG", 155382400, 5.64)]),
                            ("2026-04", [("old", "LO KHENG HONG. DRS", 154835300, 5.62),
                                         ("new", "DRS LO KHENG HONG", 155382400, 5.64)]),
                            ("2026-05", [("old", "LO KHENG HONG. DRS", 155400000, 5.65)])]:
            periods.append({"period": month, "as_of": month + "-28", "validation": "ok",
                            "total_pct": sum(row[3] for row in rows), "holders": [
                                {"name_key": key, "name": name, "total": shares, "pct": pct, "validation": "ok"}
                                for key, name, shares, pct in rows]})
        detail = {"ticker": "ABMM", "company_name": "ABM", "ksei_periods": periods}
        server = SimpleNamespace(get=lambda url: detail)
        index = {"companies": [{"ticker": "ABMM"}], "ksei": {"months": [p["period"] for p in periods]}}
        data, _, _ = sync.ownership_data(server, index, None, "test")
        company = data["companies"][0]
        self.assertEqual(data["format"], 6)
        self.assertEqual(company["k"][0]["h"][0][0], company["k"][1]["h"][0][0])
        self.assertNotIn("i", company["k"][1])
        for i in (2, 3):
            self.assertTrue(company["k"][i]["i"])
            self.assertEqual(company["p"][i][1:], [0, "K"])
            ids = [row[0] for row in company["k"][i]["h"]]
            self.assertEqual(len(ids), len(set(ids)))


class OwnershipOnlyTests(unittest.TestCase):
    def test_ownership_only_preserves_digest_bytes_and_fingerprint(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dest = root / "needtobeindexed" / "idx-signal-desk"
            dest.mkdir(parents=True)
            digest = dest / "digest_2026-09-01_2026-09-02.md"
            digest.write_text("immutable digest", encoding="utf-8")
            state = {"profile_id": "test", "digests": {"window": "fingerprint"}}
            (dest / ".sync.json").write_text(json.dumps(state))
            server = SimpleNamespace(get=lambda path, **kw: {"active_profile_id": "test", "profiles": [{"id": "test"}]})
            def sync_ownership(server, state, force, profile, guard):
                state["ownership"] = "new"
                sync.write_if_changed(sync.OWNERSHIP_JSON, '{"format":6}')
                return ["kepemilikan.json"], []
            with patch.multiple(sync, ROOT=root, DEST=dest, STATE=dest / ".sync.json",
                                OWNERSHIP_JSON=dest / "kepemilikan.json", FILINGS_JSON=dest / "kepemilikan-perubahan.json",
                                REPORTS_JSON=dest / "kepemilikan-laporan.json"), \
                    patch.object(sync, "Server", return_value=server), \
                    patch.object(sync, "sync_digests", side_effect=AssertionError("digest sync must not run")), \
                    patch.object(sync, "sync_ownership", side_effect=sync_ownership):
                self.assertTrue(sync.sync_once(SimpleNamespace(server="local", profile=None, force=False, ownership_only=True)))
            self.assertEqual(digest.read_text(), "immutable digest")
            self.assertEqual(json.loads((dest / ".sync.json").read_text())["digests"], state["digests"])


if __name__ == "__main__":
    unittest.main()
