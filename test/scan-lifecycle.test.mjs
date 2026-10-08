import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/trail.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/claude.jsonl', import.meta.url));

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-scan-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: { ...process.env, HOME: home, TRAIL_HOME: path.join(home, 'trail'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), TRAIL_NO_KEYCHAIN: '1', ORGX_API_KEY: '', OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } };
}

function scan(env, args = ['scan']) {
  const result = spawnSync(process.execPath, [cli, ...args, '--plain', '--client', 'claude'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, 'scan must finish without timeout');
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('fresh empty CLI profile finishes and remains repeatable', (t) => {
  const { home, env } = profile(t);
  const first = scan(env);
  assert.match(first.stdout, /No claude sessions found yet/);
  assert.match(first.stdout, /trail scan again/);
  assert.match(first.stdout, /trail --demo/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'trail', 'index.json'), 'utf8')).files, {});
  scan(env);
  scan(env, []); // the default one-line entry point also finishes
});

test('unchanged transcript exits after the first worker scan without rewriting it', (t) => {
  const { home, env } = profile(t);
  const root = path.join(home, '.claude', 'projects', 'proof');
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(fixture, path.join(root, 'session-proof.jsonl'));
  scan(env);
  const sessionRoot = path.join(home, 'trail', 'sessions');
  const names = fs.readdirSync(sessionRoot);
  assert.equal(names.length, 1);
  const file = path.join(sessionRoot, names[0]);
  const before = fs.readFileSync(file);
  const modified = fs.statSync(file).mtimeMs;
  scan(env);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, modified);
});
