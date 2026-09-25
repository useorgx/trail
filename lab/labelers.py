"""Off-the-shelf decision models as lab labelers, scored by the same eval as everything else.

Usage: ~/.orgx/trail/lab/.venv/bin/python lab/labelers.py fastino|gliner2-local|laya [--limit N]
Each model sees the same compact thread outline (never the raw transcript) and the same two
codebook questions (origin, status). Outputs go to ~/.orgx/trail/lab/labelers/<name>/<key>.json;
score with: node lab/eval.mjs --labeler model:<name>
"""
import json, os, re, sys, time, glob, collections

HOME = os.environ.get('TRAIL_HOME') or os.path.expanduser('~/.orgx/trail')
LAB = os.path.join(HOME, 'lab')
safe = lambda k: re.sub(r'[^\w.-]', '_', k)

ORIGIN = {
    'asked': 'a person asked for this in the session',
    'plan': 'the agent split an asked-for goal into this step itself',
    'found': 'the agent noticed a problem nobody asked about (bug, incident, leak) and took it up',
    'recovery': 'the agent worked through repeated failures of its own commands to get back on track',
    'wall': 'the agent was refused by permissions or policy and routed around it or stopped',
    'scheduled': 'a routine that ran on a timer with no live person',
}
STATUS = {
    'done': 'delivered: shipped, a check passed after the change, or the answer was given',
    'dropped': 'stopped without delivering: gave up, blocked, or moved on',
    'parked': 'left for later or waiting on a person',
    'open': 'still in progress when the log ends',
    'unclear': 'the log cannot tell',
}
QUESTIONS = {
    'origin': {'type': 'choice', 'instructions': 'Where did this piece of AI-agent work come from?', 'criteria': ORIGIN},
    'status': {'type': 'choice', 'instructions': 'How did this piece of AI-agent work end, as far as the log shows?', 'criteria': STATUS},
}
MOVE_NAMES = dict(p='reads', r='commands', c='edits', h='checks', s='ships', d='delegations', X='failures', D='permission denials')


def outline(thread):
    m = thread.get('moves', ''); c = collections.Counter(m)
    act = ', '.join(f'{c[k]} {v}' for k, v in MOVE_NAMES.items() if c[k])
    notes = ' | '.join(n[:160] for n in (thread.get('notes') or []))
    claim = '; '.join(thread.get('claim') or [])
    return (f"Request: {(thread.get('ask') or '(no direct request; the agent started this)')[:260]}\n"
            f"Agent said: {notes[:500]}\nActivity: {act or 'none'}; last moves: {m[-12:]}\n"
            + (f"Shipped: {claim}\n" if claim else ''))


def items():
    out = []
    for f in sorted(glob.glob(os.path.join(LAB, 'batches', '*.json'))):
        for it in json.load(open(f))['items']:
            p = os.path.join(HOME, 'sessions', it['sid'] + '.json')
            if not os.path.exists(p): continue
            t = next((t for t in json.load(open(p))['threads'] if t.get('spans') and t['spans'][0][0] == it['anchor']), None)
            if t: out.append((it['key'], outline(t)))
    return out


def fastino():
    import requests
    env = open(os.path.expanduser('~/Code/orgx/.env')).read()
    key = re.search(r'^FASTINO_API_KEY=(.*)$', env, re.M).group(1).strip().strip('"\'')
    schema = {'classifications': [{'task': q, 'labels': [f'{k}: {v}' for k, v in d['criteria'].items()], 'multi_label': False, 'top_k': 1} for q, d in QUESTIONS.items()]}
    def ask(text):
        for attempt in range(4):
            r = requests.post('https://api.fastino.ai/v1/chat/completions', headers={'authorization': f'Bearer {key}'}, timeout=60,
                              json={'model': 'fastino/gliner2.5-multi-v1', 'messages': [{'role': 'user', 'content': text}], 'schema': schema, 'threshold': 0, 'include_confidence': True, 'include_spans': False, 'store': False})
            if r.status_code == 200:
                c = json.loads(r.json()['choices'][0]['message']['content'])
                return {q: (c[q]['label'].split(':')[0], c[q].get('confidence')) for q in QUESTIONS}
            time.sleep(10)
        raise RuntimeError(r.text[:200])
    return ask


def gliner_local():
    from gliner2 import GLiNER2
    m = GLiNER2.from_pretrained('fastino/gliner2-base-v1')
    def ask(text):
        r = m.classify_text(text, {q: [f'{k}: {v}' for k, v in d['criteria'].items()] for q, d in QUESTIONS.items()}, include_confidence=True)
        out = {}
        for q in QUESTIONS:
            h = r.get(q) if isinstance(r, dict) else None
            if isinstance(h, list): h = h[0]
            lab = h.get('label') if isinstance(h, dict) else h
            out[q] = (str(lab).split(':')[0], h.get('confidence') if isinstance(h, dict) else None)
        return out
    return ask


def laya():
    from huggingface_hub import hf_hub_download
    src = os.path.join(LAB, 'models', 'laya')  # reviewed copies of rl_agent_api.py / rl_common.py
    for f in ['model.safetensors', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json', 'encoder/config.json']:
        dst = os.path.join(src, f)
        if not os.path.exists(dst):
            p = hf_hub_download('convaiinnovations/laya', f, local_dir=src)
    sys.path.insert(0, src)
    from rl_agent_api import RLAgent
    agent = RLAgent(src, device='mps' if __import__('torch').backends.mps.is_available() else 'cpu')
    def ask(text):
        a = agent.system_one(text, QUESTIONS)['answers']
        return {q: (a[q]['choice'], a[q].get('confidence')) for q in QUESTIONS}
    return ask


if __name__ == '__main__':
    name = sys.argv[1]; limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    ask = {'fastino': fastino, 'gliner2-local': gliner_local, 'laya': laya}[name]()
    outdir = os.path.join(LAB, 'labelers', name); os.makedirs(outdir, exist_ok=True)
    todo = [(k, s) for k, s in items() if not os.path.exists(os.path.join(outdir, safe(k) + '.json'))][:limit]
    t0 = time.time(); n = 0
    for k, s in todo:
        try:
            r = ask(s); n += 1
            json.dump({'model': name, 'origin': r['origin'][0], 'status': r['status'][0], 'conf': {q: r[q][1] for q in r}}, open(os.path.join(outdir, safe(k) + '.json'), 'w'))
        except Exception as e:
            print('fail', k, str(e)[:120])
    print(f'{name}: {n} threads in {time.time() - t0:.1f}s ({(time.time() - t0) / max(n, 1) * 1000:.0f} ms each)')
