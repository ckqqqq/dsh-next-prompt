import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { SessionRuntime } from './runtime.js';
import { Suggestion } from './Suggestion.js';
import { GENERATE_ENDPOINT } from './generation.js';

export const inject = ['slots', 'sessions', 'conversation', 'connection'];
/** Public DSH slot registration; no private Lexical access or editor monkey-patching. */
export function apply(ctx: Context): void {
  // DSH compiles Host/Client Context merges separately. This package emits both entrypoints in one build.
  const connection = ctx.connection as unknown as ConnectionHandle;
  const runtimes = new WeakMap<object, SessionRuntime>();
  const active = new Set<SessionRuntime>();
  ctx.effect(() => () => { for (const runtime of active) runtime.dispose(); active.clear(); }, 'next-prompt: plugin cleanup');
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'next-prompt', order: 20,
    inject: sessionId => {
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw new Error('next-prompt requires a retained Session');
      let runtime = runtimes.get(binding);
      if (!runtime) {
        let storage: Storage | undefined;
        try { storage = globalThis.localStorage; } catch { /* sandboxed browser */ }
        runtime = new SessionRuntime(binding, ctx.conversation.input.for(binding.ctx), storage, {
          generate: async (request, signal) => {
            const result = await connection.rpc.call('/api', GENERATE_ENDPOINT, request, signal);
            if (!result.ok) throw new Error('model prediction unavailable');
            return result.value;
          },
        });
        runtimes.set(binding, runtime);
        active.add(runtime);
        const resident = runtime;
        binding.ctx.effect(() => () => { resident.dispose(); active.delete(resident); runtimes.delete(binding); }, 'next-prompt: session model');
      }
      return { runtime };
    },
  }, Suggestion));
}
