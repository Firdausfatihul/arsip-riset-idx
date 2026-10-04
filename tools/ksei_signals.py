#!/usr/bin/env python3
"""Build-time KSEI signals for the agentic engine (stdlib, no network, no model).

The hidden-gem hunt found that gems come from joins the model never makes: month against month, issuer against
issuer. This module does those joins once per build from kepemilikan.json (KSEI >1% holders per month):

- ksei_history.json: every holder's monthly series per issuer (same holder merged across spelling variants).
- signals.json: per issuer signals with a strength tier and a sentence written by code, cross-issuer party series,
  renames, co-holding clusters and an (untuned) leaderboard.

Tiers describe the inference, not the data: "fakta" (the KSEI rows themselves), "kuat" (exact odd share counts),
"sedang" (ratio or round-lot matches, clusters), "lemah" (ambiguous matches). A cluster is a holding pattern,
never proof of acting together.
"""
import collections, itertools, json, math, re

VERSION = 'ksei-signals-v2'
BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember']
INSTITUTION = {'Mutual Funds', 'Insurance', 'Bank', 'Securities Company', 'Investment Manager', 'Trustee Bank', 'Financial Institution',
               'Financial Institutional', 'Private Bank', 'Pension Fund', 'State Owned Enterprises', 'Hedge Fund', 'Investment Advisors'}
# Custodian and nominee accounts move shares between clients; their "renames" and exits are not ownership events.
NOMINEE = re.compile(r'\b(A/C|S/A|PLEDGED?|CLIENTS?|NOMINEES?|CUSTOD(?:Y|IAN)|FOR THE ACCOUNT|OMNIBUS)\b|\bQQ\b')
CUSTODIAN = re.compile(r'\b(PANIN|DBS|LGT|UBS|CITIBANK|HSBC|STANDARD CHARTERED|DEUTSCHE|BNY|STATE STREET|JPMORGAN|JP MORGAN|'
                       r'BANK OF NEW YORK|NORTHERN TRUST|BNP PARIBAS|SOCIETE GENERALE|CREDIT SUISSE|MORGAN STANLEY|GOLDMAN|'
                       r'CGS|KGI|MAYBANK|UOB|OCBC|NOMURA|CLEARSTREAM|EUROCLEAR)\b')
LEGAL = r'\b(PT|TBK|PERSEROAN TERBATAS|THE|LTD|LIMITED|INC|CORP|CORPORATION|PTE|CO|LLC|SA|AG|BV|NV|PERSERO)\b'


def norm(name):
    return ' '.join(re.sub(LEGAL, ' ', re.sub(r'[^A-Z0-9 ]', ' ', name.upper())).split())


def tokkey(name):
    """Word order folded: "Triple Berkah Bersama" and "Triple Bersama Berkah" are the same key."""
    return ' '.join(sorted(norm(name).split()))


def custodian(name, cls):
    upper = name.upper()
    return cls in INSTITUTION or bool(NOMINEE.search(upper)) or bool(CUSTODIAN.search(upper))


def num(n):
    return f'{int(round(n)):,}'.replace(',', '.')


def pct(x):
    return f'{x:.2f}'.replace('.', ',')


def month(m):
    y, mo = m.split('-')
    return f'{BULAN[int(mo) - 1]} {y}'


def build(data):
    # kepemilikan.json format 4 also carries issuer-report months before the first KSEI file; signals use KSEI months only.
    keep = [i for i in range(len(data['months'])) if any(i < len(co.get('k') or []) and co['k'][i] for co in data['companies'])]
    months = [data['months'][i]['p'] for i in keep]
    names, classes, n = data['names'], data['classes'], len(months)
    if not n:
        return ({'version': VERSION, 'months': [], 'asof': None, 'issuers': {}, 'parties': {},
                 'renames': [], 'clusters': [], 'leaderboard': []},
                {'version': VERSION, 'months': [], 'issuers': {}})
    issuers, history = {}, {}
    for co in data['companies']:
        t, k = co['t'], [(co.get('k') or [])[i] if i < len(co.get('k') or []) else None for i in keep]
        series = {}
        for i, entry in enumerate(k):
            for inv, ni, ci, _lf, p, sh, _rows in (entry or {}).get('h', []):
                s = series.setdefault(inv, {'names': [], 'cls': classes[ci] if ci < len(classes) else '', 'pct': [None] * n, 'sh': [None] * n})
                if names[ni] not in s['names']:
                    s['names'].append(names[ni])
                s['pct'][i], s['sh'][i] = p, sh
        merge_variants(series, n)
        counts = [len((entry or {}).get('h', [])) if entry else None for entry in k] + [None] * (n - len(k))
        usable = usable_months(counts, k, n)
        # Keep the source history inspectable, but do not feed suspect values to facts,
        # rankings, party indexes or cross-issuer inference.
        clean = [{**s, 'pct': [p if usable[i] else None for i, p in enumerate(s['pct'])],
                  'sh': [sh if usable[i] else None for i, sh in enumerate(s['sh'])]} for s in series.values()]
        issuers[t] = {'n': co.get('n') or t, 'series': clean, 'usable': usable}
        history[t] = {'n': co.get('n') or t, 'usable': usable,
                      'issues': [list((entry or {}).get('i') or []) +
                                 ([] if usable[i] or (entry or {}).get('i') else ['Data KSEI tidak layak dibandingkan.'])
                                 for i, entry in enumerate(k)],
                      'holders': [{'name': s['names'][-1], 'names': s['names'], 'cls': s['cls'], 'pct': s['pct'], 'sh': s['sh']}
                                                          for s in series.values()]}
    issuer_names = {tokkey(v['n']): t for t, v in issuers.items() if len(tokkey(v['n'])) > 3}
    signals = collections.defaultdict(list)
    for t, v in issuers.items():
        pair_signals(t, v, months, signals)
        holder_signals(t, v, months, issuer_names, signals)
    renames = find_renames(issuers, months)
    clusters = find_clusters(issuers, months, signals)
    parties = party_index(issuers, months)
    score = {t: score_issuer(sig) for t, sig in signals.items()}
    ranked = sorted(signals, key=lambda t: -score[t])
    out_issuers = {}
    for t in ranked:
        top = max(((s['names'][-1], s['pct'][-1]) for s in issuers[t]['series'] if s['pct'][-1] is not None), key=lambda x: x[1], default=('', 0))
        for i, s in enumerate(signals[t]):
            s['id'] = f'{t}-{s["k"]}-{s.get("m", months[-1])}-{i}'
        out_issuers[t] = {'n': issuers[t]['n'], 'top': list(top), 'score': score[t], 'signals': signals[t]}
    leaderboard = [{'t': t, 'score': score[t], 'reason': '; '.join(s['kalimat'][:140] for s in signals[t][:2])} for t in ranked[:50]]
    return ({'version': VERSION, 'months': months, 'asof': months[-1], 'issuers': out_issuers, 'parties': parties,
             'renames': renames, 'clusters': clusters, 'leaderboard': leaderboard},
            {'version': VERSION, 'months': months, 'issuers': history})


def merge_variants(series, n):
    """One holder filed under two spellings in the same issuer: one series ends, the other starts the next month
    with the same token-set name and continuing shares (within 0.1%) or, after a capital change, the same percentage."""
    by_key = collections.defaultdict(list)
    for inv, s in series.items():
        by_key[tokkey(s['names'][-1])].append(inv)
    for invs in by_key.values():
        if len(invs) < 2:
            continue
        for a, b in itertools.permutations(invs, 2):
            if a not in series or b not in series:
                continue
            sa, sb = series[a], series[b]
            last_a = max((i for i in range(n) if sa['sh'][i] is not None), default=None)
            first_b = next((i for i in range(n) if sb['sh'][i] is not None), None)
            if last_a is None or first_b is None or first_b != last_a + 1:
                continue
            same_shares = abs(sb['sh'][first_b] - sa['sh'][last_a]) <= 0.001 * max(sa['sh'][last_a], 1)
            if same_shares or abs((sb['pct'][first_b] or 0) - (sa['pct'][last_a] or 0)) <= 0.05:
                for i in range(first_b, n):
                    sa['pct'][i], sa['sh'][i] = sb['pct'][i], sb['sh'][i]
                sa['names'] += [x for x in sb['names'] if x not in sa['names']]
                del series[b]


def usable_months(counts, k, n):
    """No facts or inferred changes use missing, empty, flagged or partial snapshots."""
    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def valid(entry):
        return bool(entry and entry.get('h') and not entry.get('i') and finite(entry.get('tp')) and
                    0 <= entry['tp'] <= 100.05 and
                    all(finite(row[4]) and 0 <= row[4] <= 100.05 and finite(row[5]) and row[5] >= 0
                        for row in entry['h']))

    ok = [i < len(k) and valid(k[i]) for i in range(n)]
    for i in range(1, n - 1):
        if ok[i] and ok[i - 1] and ok[i + 1] and counts[i - 1] >= 4 and counts[i] < 0.6 * min(counts[i - 1], counts[i + 1]):
            ok[i] = False
    return ok


def pair_signals(t, v, months, signals):
    """Transfers (one buyer) and splits (2-8 new buyers) against each seller's drop of at least 1 point."""
    series, ok = v['series'], v['usable']
    for i in range(1, len(months)):
        if not (ok[i] and ok[i - 1]):
            continue
        moves = [(s, s['sh'][i - 1] or 0, s['sh'][i] or 0) for s in series if (s['sh'][i - 1] or 0) != (s['sh'][i] or 0)]
        sellers = [x for x in moves if x[2] < x[1]]
        buyers = [x for x in moves if x[2] > x[1]]
        for s, a, b in sellers:
            drop, pdrop = a - b, (s['pct'][i - 1] or 0) - (s['pct'][i] or 0)
            if pdrop < 1:
                continue
            exact = [x for x in buyers if x[2] - x[1] == drop]
            near = [x for x in buyers if 0.97 <= (x[2] - x[1]) / drop <= 1.03]
            seller, when = s['names'][-1], month(months[i])
            if exact or near:
                pick = exact or near
                x = pick[0]
                gain = x[2] - x[1]
                round_lot = drop % 100000 == 0
                tier = 'lemah' if len(pick) > 1 else 'kuat' if exact and not round_lot else 'sedang'
                how = 'persis sama' if exact else f'{pct(100 * gain / drop)}% dari jumlah itu'
                extra = f' (ada {len(pick)} kandidat pembeli)' if len(pick) > 1 else ''
                signals[t].append({'k': 'transfer', 'm': months[i], 'tier': tier, 'from': seller, 'to': x[0]['names'][-1],
                                   'shares': drop, 'gain': gain, 'exact': bool(exact), 'pp': round(pdrop, 2),
                                   'parties': [seller, x[0]['names'][-1]], 'dari': months[i - 1], 'sampai': months[i],
                                   'kalimat': f'{when}: {seller} turun {num(drop)} lembar ({pct(pdrop)} poin); {x[0]["names"][-1]} naik '
                                              f'{num(gain)} lembar, {how}{extra}. Pola pengalihan blok menurut KSEI; lawan transaksi tidak tercatat di KSEI.'})
                continue
            new = [x for x in buyers if x[1] == 0]
            total = sum(x[2] for x in new)
            if 2 <= len(new) <= 8 and 0.9 <= total / drop <= 1.1:
                sub5 = all((x[0]['pct'][i] or 0) < 5 for x in new)
                tier = 'kuat' if total == drop else 'sedang'
                listing = ', '.join(f'{x[0]["names"][-1]} {num(x[2])}' for x in sorted(new, key=lambda x: -x[2]))
                signals[t].append({'k': 'split', 'm': months[i], 'tier': tier, 'from': seller, 'shares': drop, 'pp': round(pdrop, 2),
                                   'to': [[x[0]['names'][-1], x[2]] for x in new], 'sub5': sub5, 'exact': total == drop,
                                   'parties': [seller] + [x[0]['names'][-1] for x in new], 'dari': months[i - 1], 'sampai': months[i],
                                   'kalimat': f'{when}: {seller} turun {num(drop)} lembar ({pct(pdrop)} poin); pada bulan yang sama {len(new)} '
                                              f'pemegang baru muncul dengan total {num(total)} lembar ({pct(100 * total / drop)}%): {listing}'
                                              f'{"; semuanya di bawah 5%" if sub5 else ""}. Pola pemecahan blok, bukan bukti para pembeli bertindak bersama.'})


def holder_signals(t, v, months, issuer_names, signals):
    """New and exiting holders of at least 2%, holders just under 5%, and holders that are themselves listed issuers."""
    ok, last = v['usable'], len(months) - 1
    for s in v['series']:
        name, p = s['names'][-1], s['pct']
        if custodian(name, s['cls']):
            continue
        first = next((i for i, x in enumerate(p) if x is not None), None)
        end = max((i for i, x in enumerate(p) if x is not None), default=None)
        if first and ok[first - 1] and ok[first] and ok[last] and p[-1] is not None and p[-1] >= 2:
            signals[t].append({'k': 'new', 'm': months[first], 'tier': 'fakta', 'who': name, 'pct': p[-1], 'parties': [name],
                               'dari': months[first - 1], 'sampai': months[-1],
                               'kalimat': f'{name} pertama tercatat di atas 1% pada {month(months[first])}; kini {pct(p[-1])}% ({month(months[-1])}).'})
        if end is not None and end < last and ok[end] and ok[end + 1] and p[end] >= 2:
            signals[t].append({'k': 'exit', 'm': months[end + 1], 'tier': 'fakta', 'who': name, 'pct': p[end], 'from5': p[end] >= 5,
                               'parties': [name], 'dari': months[end], 'sampai': months[end + 1],
                               'kalimat': f'{name} ({pct(p[end])}% pada {month(months[end])}) tidak lagi tercatat di atas 1% pada {month(months[end + 1])}.'})
        if ok[last] and p[-1] is not None and 4.5 <= p[-1] < 5:
            signals[t].append({'k': 'near5', 'm': months[-1], 'tier': 'fakta', 'who': name, 'pct': p[-1], 'parties': [name],
                               'dari': months[-1], 'sampai': months[-1],
                               'kalimat': f'{name} memegang {pct(p[-1])}% ({month(months[-1])}), tepat di bawah batas pelaporan 5%.'})
        other = issuer_names.get(tokkey(name))
        if other and other != t and ok[last] and p[-1] is not None:
            signals[t].append({'k': 'issuer_holder', 'm': months[-1], 'tier': 'fakta', 'who': name, 'ticker': other, 'pct': p[-1],
                               'parties': [name], 'dari': months[-1], 'sampai': months[-1],
                               'kalimat': f'Pemegang {name} ({pct(p[-1])}%) adalah emiten tercatat {other}; pemegang saham {other} ikut relevan.'})


def find_renames(issuers, months):
    """Identical share counts leaving name A and arriving under name B in the same month, in two or more issuers."""
    gone, came = collections.defaultdict(list), collections.defaultdict(list)
    for t, v in issuers.items():
        ok = v['usable']
        for s in v['series']:
            if custodian(s['names'][-1], s['cls']):
                continue
            for i in range(1, len(months)):
                if not (ok[i - 1] and ok[i]):
                    continue
                a, b = s['sh'][i - 1], s['sh'][i]
                if a and not b:
                    gone[(months[i], s['names'][-1])].append((t, a))
                if b and not a:
                    came[(months[i], s['names'][0])].append((t, b))
    out = []
    for (m, old), g in gone.items():
        if len(g) < 2:
            continue
        for (m2, new), c in came.items():
            if m2 != m or tokkey(new) == tokkey(old):
                continue
            both = set(g) & set(c)
            if len(both) >= 2:
                tickers = sorted({t for t, _ in both})
                out.append({'m': m, 'old': old, 'new': new, 'n': len(both), 'tickers': tickers, 'tier': 'kuat' if len(both) >= 3 else 'sedang',
                            'kalimat': f'{month(m)}: saham {old} di {", ".join(tickers)} berpindah dengan jumlah lembar persis sama ke {new}; '
                                       f'kemungkinan pergantian nama atau pengalihan internal.'})
    return sorted(out, key=lambda r: (-r['n'], r['m']))


def find_clusters(issuers, months, signals):
    """Union-find over non-institution holders that share at least two issuers with each other."""
    hold, display = collections.defaultdict(dict), {}
    for t, v in issuers.items():
        for s in v['series']:
            name = s['names'][-1]
            if custodian(name, s['cls']) or s['pct'][-1] is None:
                continue
            key = tokkey(name)
            display[key] = name
            hold[key][t] = hold[key].get(t, 0) + s['pct'][-1]
    multi = {k: v for k, v in hold.items() if len(v) >= 2}
    by_issuer = collections.defaultdict(set)
    for k, v in multi.items():
        for t in v:
            by_issuer[t].add(k)
    pairs = collections.Counter()
    for t, keys in by_issuer.items():
        if len(keys) <= 60:
            for a, b in itertools.combinations(sorted(keys), 2):
                pairs[(a, b)] += 1
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for (a, b), c in pairs.items():
        if c >= 2:
            parent[find(a)] = find(b)
    groups = collections.defaultdict(set)
    for k in multi:
        if k in parent:
            groups[find(k)].add(k)
    out = []
    for members in (g for g in groups.values() if 3 <= len(g) <= 80):
        cid = len(out)
        per = collections.defaultdict(list)
        for k in sorted(members):
            for t, p in multi[k].items():
                per[t].append((display[k], round(p, 2)))
        entry = {'id': cid, 'members': sorted(display[k] for k in members), 'issuers': {}}
        for t, rows in per.items():
            total = round(sum(p for _, p in rows), 2)
            if len(rows) < 3 or total < 5:
                continue
            top = max(((s['names'][-1], s['pct'][-1]) for s in issuers[t]['series'] if s['pct'][-1] is not None), key=lambda x: x[1], default=('', 0))
            rows = sorted(rows, key=lambda r: -r[1])
            vs_top = round(total - top[1], 2)
            sub5 = sum(1 for _, p in rows if p < 5)
            entry['issuers'][t] = {'total': total, 'n': len(rows), 'sub5': sub5, 'vs_top': vs_top, 'top': top[0]}
            listing = ', '.join(f'{name} {pct(p)}%' for name, p in rows[:8])
            compare = (f', {pct(vs_top)} poin di atas pemegang terbesar {top[0]}' if vs_top > 0 else '')
            signals[t].append({'k': 'cluster', 'm': months[-1], 'tier': 'sedang', 'c': cid, 'n': len(rows), 'total': total, 'sub5': sub5,
                               'vs_top': vs_top, 'top': top[0], 'members': [[name, p] for name, p in rows[:8]],
                               'parties': [name for name, _ in rows[:8]], 'dari': months[-1], 'sampai': months[-1],
                               'kalimat': f'{len(rows)} pemegang yang juga saling bertemu di emiten lain memegang total {pct(total)}% '
                                          f'({month(months[-1])}){compare}: {listing}. Pola kepemilikan, bukan bukti bertindak bersama.'})
        if entry['issuers']:
            out.append(entry)
    return out


def party_index(issuers, months):
    """Cross-issuer series per party (token-set key), for "where else does this name hold shares"."""
    out = {}
    for t, v in issuers.items():
        for s in v['series']:
            p = s['pct']
            idx = [i for i, x in enumerate(p) if x is not None]
            if not idx:
                continue
            key = tokkey(s['names'][-1])
            entry = out.setdefault(key, {'name': s['names'][-1], 'variants': [], 'series': []})
            entry['variants'] += [x for x in s['names'] if x not in entry['variants']]
            entry['series'].append([t, months[idx[0]], months[idx[-1]], p[idx[0]], p[idx[-1]], max(p[i] for i in idx)])
    return out


WEIGHT = {'transfer': 3, 'split': 5, 'new': 1, 'exit': 1, 'near5': 1, 'cluster': 2, 'issuer_holder': 1}


def score_issuer(sig):
    score = 0.0
    for x in sig:
        w = WEIGHT.get(x['k'], 1)
        if x['k'] == 'transfer':
            w += (2 if x['tier'] == 'kuat' else 0) + min(3, x['pp'] / 5)
        if x['k'] == 'split' and x['sub5']:
            w += 3
        if x['k'] == 'new':
            w += min(3, x['pct'] / 5)
        if x['k'] == 'exit' and x['from5']:
            w += 1
        if x['k'] == 'cluster':
            w += min(4, x['total'] / 8) + (3 if x['vs_top'] > 0 else 0) + min(2, x['sub5'] / 3)
        score += w
    return round(score, 1)


def write(source, out_dir):
    """Writes signals.json and ksei_history.json into out_dir; returns the manifest entry, or None without source."""
    if not source.exists():
        return None
    signals, history = build(json.loads(source.read_text(encoding='utf-8')))
    compact = {'ensure_ascii': False, 'separators': (',', ':')}
    (out_dir / 'signals.json').write_text(json.dumps(signals, **compact), encoding='utf-8')
    (out_dir / 'ksei_history.json').write_text(json.dumps(history, **compact), encoding='utf-8')
    return {'version': VERSION, 'month': signals['asof'], 'asset': 'signals.json', 'history': 'ksei_history.json',
            'issuers': len(signals['issuers']), 'bytes': (out_dir / 'signals.json').stat().st_size,
            'history_bytes': (out_dir / 'ksei_history.json').stat().st_size}


if __name__ == '__main__':
    import pathlib, sys, tempfile
    root = pathlib.Path(__file__).resolve().parents[1]
    target = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp())
    print(json.dumps(write(root / 'needtobeindexed' / 'idx-signal-desk' / 'kepemilikan.json', target)), '->', target)
