import { LIMITS, Predictor, safeText } from './engine.js';

export interface LearningEvent {
  seq: number; time: number; type: string; surfaceOp?: unknown;
  data: unknown;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    const b = record(block);
    return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
  }).filter(Boolean).join('\n');
}
/** One session, monotonic seq. Baseline/reconnect/history paging never trains the model. */
export class Learner {
  private watermark = -1;
  private previous = '';
  private assistant = '';
  constructor(readonly predictor: Predictor) {}
  context(): string { return [this.previous, this.assistant].filter(Boolean).join('\n').slice(0, LIMITS.context); }
  baseline(events: readonly LearningEvent[]): void {
    this.previous = ''; this.assistant = '';
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      this.watermark = Math.max(this.watermark, event.seq);
      this.process(event, false);
    }
  }
  ingest(events: readonly LearningEvent[], enabled: boolean): boolean {
    let changed = false;
    for (const event of events) {
      if (event.seq <= this.watermark) continue;
      this.watermark = event.seq;
      changed = this.process(event, enabled) || changed;
    }
    return changed;
  }
  private process(event: LearningEvent, learn: boolean): boolean {
    const data = record(event.data);
    if (!data) return false;
    // Edits/removals invalidate the immediate context and never become training pairs.
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
      this.previous = ''; this.assistant = ''; return false;
    }
    if (event.type === 'assistant/message') {
      const text = textOf(record(data.message)?.content);
      this.assistant = safeText(text, LIMITS.context) ? text.slice(0, 700) : '';
      return false;
    }
    if (event.type !== 'user/message') return false;
    const source = record(data.source);
    // Automation/agent messages must not train or bridge two unrelated human turns.
    if (source?.kind !== 'user') { this.previous = ''; this.assistant = ''; return false; }
    const text = textOf(data.content);
    if (!safeText(text) || /^[\/@]/u.test(text.trim())) {
      this.previous = ''; this.assistant = ''; return false;
    }
    const context = this.context();
    const trained = learn && this.predictor.learn(context, text, event.time);
    this.previous = text; this.assistant = '';
    return trained;
  }
}
