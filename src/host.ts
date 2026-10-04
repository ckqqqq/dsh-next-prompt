import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-client-connection';
import { GENERATE_ENDPOINT, GENERATION_SYSTEM, parseGenerationRequest, parseGenerationResult } from './generation.js';

/** Optional model route. Credentials remain in DSH's existing provider configuration. */
export interface Config { provider?: string; model?: string }

/** No model request occurs until the user explicitly enables model predictions in the client. */
export function apply(ctx: Context, config: Config = {}): void {
  if ((config.provider === undefined) !== (config.model === undefined)
    || (config.provider !== undefined && (!config.provider.trim() || !config.model?.trim()))) {
    throw new Error('next-prompt: provider and model must be non-empty and supplied together');
  }
  ctx.inject(['connection', 'llm', 'agentDefaultModel'], scope => {
    const owner = new AbortController();
    let active = 0;
    const calls: number[] = [];
    scope.effect(() => () => owner.abort(), 'next-prompt: abort model calls on unload');
    scope.connection.rpc.intercept('/api', endpoint => endpoint === GENERATE_ENDPOINT,
      async (_endpoint, payload, signal) => {
        const request = parseGenerationRequest(payload);
        const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message, details: {} } });
        if (!request) return fail('next-prompt/invalid', 'Prediction input is invalid or contains sensitive text.');
        const now = Date.now();
        while (calls.length && now - calls[0]! >= 60_000) calls.shift();
        if (active >= 2 || calls.length >= 24) return fail('next-prompt/rate-limit', 'Prediction request limit reached.');
        if (owner.signal.aborted || signal.aborted) return fail('next-prompt/cancelled', 'Prediction cancelled.');
        active++; calls.push(now);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        owner.signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 7_000);
        try {
          const selection = scope.agentDefaultModel.currentSelection();
          const options: GenerateOptions = {
            provider: config.provider ?? selection.provider, model: config.model ?? selection.model,
            system: GENERATION_SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(request) }] }],
            maxTokens: 256, temperature: 0.2, signal: controller.signal,
          };
          const assembler = new BlockAssembler();
          let size = 0;
          const collect = async () => {
            for await (const chunk of scope.llm.stream(options)) {
              controller.signal.throwIfAborted();
              if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') size += chunk.text.length;
              if (size > 16_000) throw new Error('oversize output');
              assembler.push(chunk);
            }
          };
          let rejectAbort: (() => void) | undefined;
          const cancelled = new Promise<never>((_resolve, reject) => {
            rejectAbort = () => reject(new Error('prediction cancelled'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
          });
          try { await Promise.race([collect(), cancelled]); }
          finally { if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); }
          controller.signal.throwIfAborted();
          if (assembler.finish.kind !== 'stop' || assembler.blocks().some(x => x.type === 'tool-call')) throw new Error('invalid output');
          const text = assembler.blocks().filter(x => x.type === 'text').map(x => x.text).join('');
          if (text.length > 4_000) throw new Error('oversize output');
          return { ok: true, value: parseGenerationResult(JSON.parse(text), request.prefix) };
        } catch {
          // Provider messages can include credentials/context; return only a fixed diagnostic.
          return fail(controller.signal.aborted ? 'next-prompt/cancelled' : 'next-prompt/unavailable',
            'Model prediction unavailable; local suggestions remain available.');
        } finally {
          clearTimeout(timeout); signal.removeEventListener('abort', abort); owner.signal.removeEventListener('abort', abort); active--;
        }
      });
  });
}
