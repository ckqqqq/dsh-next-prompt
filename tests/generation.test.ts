import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationCoordinator, parseGenerationRequest, parseGenerationResult } from '../src/generation.js';
import { apply } from '../src/host.js';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

const request = { context: 'fix login\nlogin fixed', prefix: 'run', examples: [] };
test('model protocol preserves prefix, drops unsafe output and refuses sensitive input', () => {
  assert.deepEqual(parseGenerationRequest(request), request);
  for (const context of ['password=private', 'mail me@company.com', 'x'.repeat(1601)]) {
    assert.equal(parseGenerationRequest({ ...request, context }), undefined);
  }
  assert.equal(parseGenerationRequest({ ...request, examples: Array(6).fill({ context: 'okay', text: 'fine' }) }), undefined);
  assert.deepEqual(parseGenerationResult({ suggestions: ['run tests', 'run tests', 'wrong prefix'] }, 'run'), { suggestions: ['run tests'] });
  assert.deepEqual(parseGenerationResult({ suggestions: ['password=private', '/deploy'] }, ''), { suggestions: [] });
});
test('coordinator rejects stale results, caches and does not train on model guesses', async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const signals: AbortSignal[] = [];
  const c = new GenerationCoordinator((_request, signal) => {
    signals.push(signal); return new Promise(resolve => resolvers.push(resolve));
  });
  const first = c.predict(request);
  const second = c.predict({ ...request, prefix: 'run ' });
  assert.equal(signals[0]?.aborted, true);
  resolvers[0]!({ suggestions: ['run stale'] });
  resolvers[1]!({ suggestions: ['run new tests'] });
  assert.equal(await first, undefined);
  assert.deepEqual(await second, { suggestions: ['run new tests'] });
  assert.deepEqual(await c.predict({ ...request, prefix: 'run ' }), { suggestions: ['run new tests'] });
  assert.equal(signals.length, 2); c.clear();
});
test('coordinator bounds requests and uses a failure cooldown', async () => {
  let now = 100; let calls = 0;
  const c = new GenerationCoordinator(async () => { calls++; throw new Error('private provider error'); }, () => now);
  await c.predict(request); await c.predict(request); assert.equal(calls, 1);
  now += 30_001; await c.predict(request); assert.equal(calls, 2); c.clear();
  const limited = new GenerationCoordinator(async () => { calls++; return { suggestions: [] }; }, () => now);
  calls = 0;
  for (let i = 0; i < 10; i++) await limited.predict({ ...request, context: `context ${i}` });
  assert.equal(calls, 8); limited.clear();
});

function host(stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  let handler: ConnectionRpcHandler | undefined;
  let cleanup = () => {};
  const scope = {
    effect(callback: () => () => void) { cleanup = callback(); },
    connection: { rpc: { intercept(channel: string, matches: (name: string) => boolean, fn: ConnectionRpcHandler) {
      assert.equal(channel, '/api'); assert.equal(matches('next-prompt/generate'), true);
      assert.equal(matches('session/prompt'), false); handler = fn;
    } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    llm: { stream },
  };
  apply({ inject(_keys: string[], callback: (ctx: typeof scope) => void) { callback(scope); } } as never);
  return { call: (payload: unknown, signal = new AbortController().signal) => handler!('next-prompt/generate', payload, signal, {} as never),
    cleanup: () => cleanup() };
}
test('host uses configured DSH model, no tools, fixed diagnostics and bounded response parsing', async () => {
  let options: GenerateOptions | undefined;
  const h = host(async function* (input) { options = input; yield { type: 'text-delta', index: 0, text: '{"suggestions":["run new tests"]}' }; });
  assert.deepEqual(await h.call(request), { ok: true, value: { suggestions: ['run new tests'] } });
  assert.equal(options?.provider, 'test'); assert.equal(options?.tools, undefined); assert.equal(options?.sessionId, undefined);
  const invalid = await h.call({ ...request, context: 'token=private' }); assert.equal(invalid.ok, false);
  h.cleanup(); assert.equal((await h.call(request)).ok, false);
  const broken = host(async function* () { throw new Error('API key or private context'); });
  const failure = await broken.call(request);
  assert.equal(failure.ok, false); assert.doesNotMatch(JSON.stringify(failure), /API key|private context/); broken.cleanup();
});
test('host cancellation settles even if provider ignores its signal', async () => {
  const h = host(async function* () { await new Promise(() => {}); });
  const controller = new AbortController();
  const call = h.call(request, controller.signal);
  controller.abort();
  const value = await call;
  assert.equal(value.ok, false); if (!value.ok) assert.equal(value.error.code, 'next-prompt/cancelled'); h.cleanup();
});
