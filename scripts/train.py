"""Distill the abandonment decision from model-labeled threads into a small tree ensemble the CLI evaluates in JS.
Usage: python scripts/train.py <trail_home> <labels.json from the model pass> <digests_dir> <out.json>
Labels come from a slower model pass (or human labels); features come from the CLI itself, so train == serve."""
import json,os,re,sys,numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import GroupKFold
from sklearn.metrics import precision_score,recall_score,f1_score
home,corpus_path,digests,out=sys.argv[1:5]
c=json.load(open(corpus_path));silver={}
for t in c['threads']: silver.setdefault(t['sid'],[]).append(t)
def norm(s):
  m=re.search(r'scheduled-task name="([^"]+)"|\[scheduled\] (\S+)',s)
  return 'sched '+(m.group(1) or m.group(2)) if m else re.sub(r'\W+',' ',s.lower())[:50].strip()
X=[];Y=[];G=[];R=[]
for sid,S in silver.items():
  p=f'{home}/sessions/{sid}.json'
  if not os.path.exists(p): continue
  F=json.load(open(p))['threads']
  dig={int(l.split(' ',1)[0][1:]):l for l in open(f'{digests}/{sid}.txt').read().split('\n') if l.startswith('s')}
  byask={}
  for t in S:
    l=dig.get(t['origin_step'],'')
    if ' H ' in l[:8]: byask.setdefault(norm(l.split('ASK:',1)[-1]),t)
  for f in F:
    if not f.get('ask'): continue
    s=byask.get(norm(f['ask']))
    if not s: continue
    X.append(f['feat']);Y.append(int(s['status']=='abandoned'));G.append(sid);R.append(int(f['status_rule']=='abandoned'))
X=np.array(X,float);Y=np.array(Y);R=np.array(R)
mk=lambda:GradientBoostingClassifier(n_estimators=80,max_depth=3,learning_rate=0.1,subsample=0.9,random_state=0)
P=np.zeros(len(Y))
for tr,te in GroupKFold(5).split(X,Y,G):
  w=np.where(Y[tr]==1,(len(Y[tr])-Y[tr].sum())/max(Y[tr].sum(),1),1.0)
  P[te]=mk().fit(X[tr],Y[tr],sample_weight=w).predict_proba(X[te])[:,1]
pred=(P>=.5).astype(int)
cv=dict(n=int(len(Y)),positives=int(Y.sum()),precision=round(precision_score(Y,pred),3),recall=round(recall_score(Y,pred),3),f1=round(f1_score(Y,pred),3),rules_f1=round(f1_score(Y,R),3))
print(cv)
w=np.where(Y==1,(len(Y)-Y.sum())/max(Y.sum(),1),1.0);m=mk().fit(X,Y,sample_weight=w)
init=float(m._raw_predict_init(X[:1])[0][0])
trees=[]
for est in m.estimators_[:,0]:
  t=est.tree_;trees.append(dict(feature=t.feature.tolist(),threshold=[round(x,6) for x in t.threshold.tolist()],left=t.children_left.tolist(),right=t.children_right.tolist(),value=[round(v[0][0],6) for v in t.value.tolist()]))
json.dump(dict(name='abandon-gbdt-v1',trained_on='Sonnet-labeled threads from 216 Claude Code sessions (silver labels), grouped 5-fold CV',cv=cv,init=init,lr=m.learning_rate,trees=trees),open(out,'w'))
# parity check: JS-style evaluation must equal sklearn
def ev(t,x):
  n=0
  while t['left'][n]!=-1: n=t['left'][n] if x[t['feature'][n]]<=t['threshold'][n] else t['right'][n]
  return t['value'][n]
z=[init+m.learning_rate*sum(ev(t,x) for t in trees) for x in X[:50]]
print('parity max diff',float(np.max(np.abs(1/(1+np.exp(-np.array(z)))-m.predict_proba(X[:50])[:,1]))))
