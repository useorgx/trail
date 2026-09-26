"""Provisional leaderboard: every labeler vs. the model jury, BEFORE human gold exists.

This is not accuracy. It says how often a cheap labeler agrees with expensive models, which predicts
where your labeling time will go. Replace with `node lab/eval.mjs` once gold labels exist.
Usage: python3 lab/provisional.py
"""
import json, os, re, glob, collections

HOME = os.environ.get('TRAIL_HOME') or os.path.expanduser('~/.orgx/trail')
LAB = os.path.join(HOME, 'lab'); safe = lambda k: re.sub(r'[^\w.-]', '_', k)
items = [i for f in sorted(glob.glob(os.path.join(LAB, 'batches', '*.json'))) for i in json.load(open(f))['items']]

def load(kind, name, key):
    p = os.path.join(LAB, kind, name, safe(key) + '.json')
    if not os.path.exists(p): return None
    d = json.load(open(p)); return d.get('label', d)

JURY = ['haiku', 'sonnet', 'opus']
def majority(key, f):
    vs = [v[f] for v in (load('jury', m, key) for m in JURY) if v]
    if len(vs) < 3: return None
    top, n = collections.Counter(vs).most_common(1)[0]
    return top if n >= 2 else None

labelers = {'trail (rules + tree model, $0)': lambda it, f: it['pred'][f]}
for m in ['fastino', 'gliner2-local', 'laya']: labelers[f'{m} (zero-shot)'] = (lambda m: lambda it, f: (load('labelers', m, it['key']) or {}).get(f))(m)
for m in JURY: labelers[f'jury:{m}'] = (lambda m: lambda it, f: (load('jury', m, it['key']) or {}).get(f))(m)

refs = {'vs opus': lambda it, f: (load('jury', 'opus', it['key']) or {}).get(f), 'vs jury majority (2 of 3)': lambda it, f: majority(it['key'], f)}
for rname, ref in refs.items():
    print(f'\n{rname}   (provisional: models, not your labels)')
    print(f"  {'labeler':34} {'origin':>8} {'status':>8}  n")
    for lname, lab in labelers.items():
        row = []
        for f in ('origin', 'status'):
            pairs = [(lab(it, f), ref(it, f)) for it in items]; pairs = [(a, b) for a, b in pairs if a and b]
            row.append((sum(a == b for a, b in pairs) / len(pairs), len(pairs)) if pairs else (float('nan'), 0))
        print(f"  {lname:34} {row[0][0]:8.0%} {row[1][0]:8.0%}  {row[0][1]}")

# How hard is the task? Unanimity among the three models, per field.
for f in ('boundary', 'origin', 'status'):
    ls = [[(load('jury', m, it['key']) or {}).get(f) for m in JURY] for it in items]; ls = [l for l in ls if all(l)]
    if ls: print(f"\njury unanimous on {f}: {sum(len(set(l)) == 1 for l in ls) / len(ls):.0%} of {len(ls)}")
