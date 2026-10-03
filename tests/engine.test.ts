import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Predictor, LIMITS } from '../src/engine.js';
import { Learner } from '../src/learning.js';
import { LocalModel } from '../src/storage.js';

const now = 1_800_000_000_000;
const model = () => new Predictor(() => now);
test('cold start abstains; repeated transitions predict Chinese next prompts', () => {
  const p = model();
  assert.deepEqual(p.predict('修复登录错误'), []);
  p.learn('修复登录错误\n已经修复登录错误', '运行相关测试');
  assert.deepEqual(p.predict('修复登录错误\n已经修复登录错误'), []);
  p.learn('修复登录错误\n已经修复登录错误', '运行相关测试');
  assert.equal(p.predict('修复登录错误\n已经修复登录错误')[0]?.text, '运行相关测试');
  assert.deepEqual(p.predict('天气和旅游计划'), []);
});
test('prefix completion is verbatim, never replaces typed text', () => {
  const p = model(); p.learn('fix login', 'run login tests');
  assert.equal(p.predict('fix login', 'run')[0]?.suffix, ' login tests');
  assert.deepEqual(p.predict('fix login', 'RUN'), []);
  assert.deepEqual(p.predict('fix login', 'run login tests'), []);
  assert.deepEqual(p.predict('fix login', '/run'), []);
});
test('dismiss feedback suppresses suggestions; acceptance cannot add training samples', () => {
  const p = model(); p.learn('fix login', 'run login tests');
  p.feedback('run login tests', 'dismissed');
  p.feedback('run login tests', 'dismissed');
  assert.deepEqual(p.predict('fix login', 'run'), []);
  const n = p.export().samples.length;
  p.feedback('invented unsent prompt', 'accepted');
  assert.equal(p.export().samples.length, n);
});
test('sensitive text, commands, oversized and expired records are excluded', () => {
  const p = model();
  for (const text of ['password=hello', 'api_key: abc', 'token=secret', 'sk-abcdefghijklmnopq', 'mail a@b.com', '/deploy']) {
    assert.equal(p.learn('ordinary context', text), false, text);
  }
  assert.equal(p.learn('password=hello', '运行测试'), false);
  assert.equal(p.learn('context', 'a'.repeat(LIMITS.text + 1)), false);
  assert.equal(p.learn('context', 'valid text', now - LIMITS.ageMs - 1), false);
});
test('bounded model, defensive restore, copies, retention', () => {
  let clock = now; const p = new Predictor(() => clock);
  for (let i = 0; i < 400; i++) p.learn('ordinary context', `candidate ${i}`);
  assert.equal(p.export().samples.length, LIMITS.samples);
  const saved = p.export(); saved.samples[0]!.text = 'mutated';
  assert.notEqual(p.export().samples[0]?.text, 'mutated');
  for (const invalid of [null, { version: 2, samples: [] }, { version: 1, samples: [null] },
    { version: 1, samples: [{ context: 'okay', text: 'okay', time: now, accepted: -1, dismissed: 0 }] }]) {
    assert.equal(p.restore(invalid), false);
  }
  const q = model(); assert.equal(q.restore(p.export()), true);
  clock += LIMITS.ageMs + 1; assert.equal(p.export().samples.length, 0);
});

const user = (seq: number, text: string, kind = 'user') => ({ seq, time: now, type: 'user/message', surfaceOp: 'append',
  data: { source: { kind }, content: [{ type: 'text', text }] } });
test('learning uses durable human events, not baselines, duplicates or assistant suggestions', () => {
  const p = model(), learner = new Learner(p);
  learner.baseline([user(1, 'fix login')]);
  assert.equal(p.export().samples.length, 0);
  const assistant = { seq: 2, time: now, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'login fixed' }] } } };
  learner.ingest([assistant, user(3, 'run login tests')], true);
  assert.equal(p.export().samples[0]?.context, 'fix login\nlogin fixed');
  learner.ingest([user(3, 'run login tests')], true);
  learner.baseline([user(1, 'fix login'), assistant, user(3, 'run login tests')]);
  assert.equal(p.export().samples.length, 1);
  learner.ingest([user(4, 'automated suggestion', 'workflow'), user(5, 'next human')], true);
  assert.equal(p.export().samples.length, 1);
});
test('disabled learning and private records do not create transitions', () => {
  const p = model(), learner = new Learner(p);
  learner.ingest([user(1, 'first prompt'), user(2, 'second prompt')], false);
  assert.equal(p.export().samples.length, 0);
  learner.ingest([user(3, 'password=private'), user(4, 'after private')], true);
  assert.equal(p.export().samples.length, 0);
});
test('storage is opt-in, session-isolated, forgettable and handles denial', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  const a = new LocalModel('a', storage); assert.equal(a.enabled, false); assert.equal(data.size, 0);
  a.enable(); a.predictor.learn('fix login', 'run tests'); a.save();
  assert.equal(new LocalModel('a', storage).enabled, true);
  assert.equal(new LocalModel('b', storage).enabled, false);
  a.forget(); assert.equal(a.predictor.export().samples.length, 0); assert.equal(data.size, 0);
  const denied = new LocalModel('denied', { ...storage, setItem() { throw new Error('quota'); } });
  denied.enable(); assert.match(denied.error, /内存/);
});
