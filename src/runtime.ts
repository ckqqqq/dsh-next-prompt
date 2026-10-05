import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Learner } from './learning.js';
import { LocalModel } from './storage.js';
import type { StoragePort } from './storage.js';
import { GenerationCoordinator, parseGenerationRequest } from './generation.js';
import type { GenerationRequest } from './generation.js';

export interface RuntimeOptions {
  generate?: (request: GenerationRequest, signal: AbortSignal) => Promise<unknown>;
}

/** One owner per retained Session generation; the Cordis scope disposes its subscription. */
export class SessionRuntime {
  readonly model: LocalModel;
  readonly learner: Learner;
  readonly generator: GenerationCoordinator | undefined;
  modelPredictions = false;
  generationStatus: 'idle' | 'pending' | 'unavailable' = 'idle';
  generated: { text: string; context: string; prefix: string; draftRev: number } | undefined;
  private version = 0;
  private listeners = new Set<() => void>();
  private disposeFeed: () => void;
  private disposeStorage: () => void = () => {};
  private disposed = false;
  private generationRevision = 0;
  constructor(readonly binding: SessionBinding, readonly input: SessionInput, storage?: StoragePort, options: RuntimeOptions = {}) {
    this.model = new LocalModel(String(binding.sessionId), storage);
    this.learner = new Learner(this.model.predictor);
    this.generator = options.generate ? new GenerationCoordinator(options.generate) : undefined;
    this.baseline();
    this.disposeFeed = binding.eventSource.subscribe(() => {
      const window = binding.eventSource.getSnapshot();
      if (window.change.kind === 'replace') this.baseline();
      else if (window.change.kind === 'append') {
        const changed = this.learner.ingest(window.change.entries
          .filter(x => x.type === 'event').map(x => x.event), this.model.enabled);
        if (changed) this.model.save();
      }
      // Prepend does not rewind context; streaming never writes learning data.
      this.emit();
    });
    if (typeof window !== 'undefined') {
      const onStorage = (event: StorageEvent) => {
        if (event.key === this.model.key || event.key === null) {
          this.cancelGeneration(); this.model.reload(); if (!this.model.enabled) this.modelPredictions = false; this.emit();
        }
      };
      window.addEventListener('storage', onStorage);
      this.disposeStorage = () => { window.removeEventListener('storage', onStorage); };
    }
  }
  private baseline(): void {
    this.learner.baseline(this.binding.eventSource.getSnapshot().entries
      .filter(x => x.type === 'event').map(x => x.event));
  }
  getSnapshot = (): number => this.version;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  emit(): void { this.version++; for (const fn of this.listeners) fn(); }
  enable(): void { this.model.enable(); this.emit(); }
  forget(): void { this.cancelGeneration(); this.modelPredictions = false; this.model.forget(); this.emit(); }
  setModelPredictions(enabled: boolean): void {
    this.cancelGeneration(); this.modelPredictions = enabled && this.model.enabled && this.generator !== undefined; this.emit();
  }
  cancelGeneration(): void { this.generationRevision++; this.generator?.cancel(); this.generated = undefined; this.generationStatus = 'idle'; }
  /** Debouncing belongs to the view; this method verifies state before AND after inference. */
  async predictWithModel(prefix: string): Promise<void> {
    if (this.disposed || !this.model.enabled || !this.modelPredictions || !this.generator) return;
    const input = this.input.state.getSnapshot();
    if (input.phase !== 'plain' || input.draft !== prefix || input.occurrences.length || input.attachmentIds.length) return;
    const context = this.learner.context();
    const request = parseGenerationRequest({ context, prefix, examples: this.model.predictor.examples(context) });
    if (!request) return;
    const revision = ++this.generationRevision;
    this.generationStatus = 'pending'; this.emit();
    const result = await this.generator.predict(request);
    const live = this.input.state.getSnapshot();
    if (revision !== this.generationRevision || this.disposed || !this.modelPredictions || !this.model.enabled || live.draftRev !== input.draftRev
      || live.draft !== prefix || live.phase !== 'plain' || context !== this.learner.context()) return;
    this.generated = result?.suggestions[0] ? { text: result.suggestions[0], context, prefix, draftRev: input.draftRev } : undefined;
    this.generationStatus = result ? 'idle' : 'unavailable'; this.emit();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generator?.clear();
    this.disposeFeed(); this.disposeStorage(); this.listeners.clear(); this.model.predictor.clear();
  }
}
