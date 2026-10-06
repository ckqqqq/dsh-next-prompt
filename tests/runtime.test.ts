import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { apply } from '../src/client.js';
import { SessionRuntime } from '../src/runtime.js';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client';

test('registration passes real DSH SlotCore validation and disposes', () => {
  const slots = new SlotCore();
  const declare = slots.register({ name: 'root', children: {
    'conversation.input.overlay': { kind: 'list', scope: 'session' },
  } }, () => null);
  let release = () => {};
  apply({ effect() {}, slots: {
    inject(_name: string, cb: () => () => void) { release = cb(); },
    register: slots.register.bind(slots),
  } } as never);
  assert.equal(slots.entries('conversation.input.overlay')[0]?.options.id, 'next-prompt');
  release(); assert.equal(slots.entries('conversation.input.overlay').length, 0); declare();
});

test('runtime trains once, skips prepend and replacement replay; dispose stops recording', () => {
  let listener: (() => void) | undefined;
  const now = Date.now();
  const user = (seq: number, text: string) => ({ type: 'event', event: { type: 'user/message', seq, time: now,
    surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } });
  let entries = [user(1, 'fix login')];
  let snapshot = { entries, change: { kind: 'replace', entries } };
  const binding = { sessionId: 'runtime', eventSource: {
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) { listener = fn; return () => { listener = undefined; }; },
  } } as unknown as SessionBinding;
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  const runtime = new SessionRuntime(binding, {} as SessionInput, storage);
  const publish = (kind: string, changes: typeof entries) => {
    entries = kind === 'replace' ? changes : [...entries, ...changes];
    snapshot = { entries, change: { kind, entries: changes } }; listener?.();
  };
  runtime.enable();
  publish('append', [user(2, 'run login tests')]);
  assert.equal(runtime.model.predictor.export().samples.length, 1);
  publish('append', [user(2, 'run login tests')]);
  publish('prepend', [user(0, 'old history')]);
  publish('replace', [user(1, 'fix login'), user(2, 'run login tests')]);
  assert.equal(runtime.model.predictor.export().samples.length, 1);
  assert.equal(runtime.learner.context(), 'run login tests');
  runtime.forget(); assert.equal(records.size, 0);
  publish('append', [user(3, 'should not learn')]);
  assert.equal(runtime.model.predictor.export().samples.length, 0);
  runtime.dispose(); runtime.dispose(); assert.equal(listener, undefined);
});
