/** Bounded online retrieval model. Scores are ranking weights, not probabilities. */
export const LIMITS = { samples: 256, text: 800, context: 1600, ageMs: 30 * 86400_000 } as const;
export interface Sample {
  context: string; text: string; time: number; accepted: number; dismissed: number;
}
export interface Candidate { text: string; suffix: string; score: number; evidence: number }
export interface ModelData { version: 1; samples: Sample[] }

const secret = /(?:-----BEGIN .*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_\-]{12,}|\bBearer\s+\S+|\b(?:api[_-]?key|password|passwd|secret|token|密码|密钥)\s*[:=：]\s*\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{17}[\dX]\b)/iu;
/** Whole records are excluded, rather than storing reversible masked secrets. Heuristic only. */
export function safeText(text: unknown, max: number = LIMITS.text): text is string {
  return typeof text === 'string' && text.trim().length >= 2 && text.length <= max
    && !secret.test(text) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text);
}
function tokens(text: string): Set<string> {
  const s = text.toLocaleLowerCase().normalize('NFKC');
  const words = s.match(/[a-z0-9_]+|[\p{Script=Han}]/gu) ?? [];
  const out = new Set(words);
  for (let i = 1; i < words.length; i++) out.add(`${words[i - 1]}:${words[i]}`);
  return out;
}
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / Math.sqrt(a.size * b.size);
}
export class Predictor {
  private samples: Sample[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void { this.samples = []; }
  private prune(): void {
    const now = this.now();
    this.samples = this.samples.filter(x => x.time <= now && now - x.time <= LIMITS.ageMs).slice(-LIMITS.samples);
  }
  /** Only call after a durable human message; skipped private input breaks the transition chain. */
  learn(context: string, text: string, time = this.now()): boolean {
    if (!safeText(text) || !safeText(context, LIMITS.context) || !Number.isFinite(time)
      || time > this.now() || this.now() - time > LIMITS.ageMs || /^[\/@]/u.test(text.trim())) return false;
    this.samples.push({ context, text, time, accepted: 0, dismissed: 0 });
    this.prune();
    return true;
  }
  feedback(text: string, kind: 'accepted' | 'dismissed'): void {
    for (const sample of this.samples) if (sample.text === text) sample[kind] = Math.min(100, sample[kind] + 1);
  }
  /** Relevant observed pairs for optional model conditioning; never includes unsent predictions. */
  examples(context: string): { context: string; text: string }[] {
    this.prune();
    const query = tokens(context);
    return [...this.samples].map(sample => ({ sample, score: similarity(query, tokens(sample.context)) }))
      .filter(x => x.score > 0 && x.sample.dismissed <= x.sample.accepted)
      .sort((a, b) => b.score - a.score || b.sample.time - a.sample.time)
      .slice(0, 5).map(({ sample }) => ({ context: sample.context, text: sample.text }));
  }
  predict(context: string, prefix = '', limit = 3): Candidate[] {
    this.prune();
    if ((prefix && (!safeText(prefix) || /^[\/@]/u.test(prefix.trim())))
      || !Number.isInteger(limit) || limit < 1) return [];
    const query = tokens(context);
    const groups = new Map<string, { best: number; evidence: number }>();
    for (const sample of this.samples) {
      if (!sample.text.startsWith(prefix) || sample.text === prefix) continue;
      const sim = similarity(query, tokens(sample.context));
      if (!prefix && sim < 0.25) continue;
      const freshness = 2 ** (-(this.now() - sample.time) / (7 * 86400_000));
      const preference = (2 + sample.accepted) / (2 + sample.accepted + sample.dismissed * 2);
      const score = (prefix ? 0.55 + 0.45 * sim : sim) * (0.7 + 0.3 * freshness) * preference;
      const group = groups.get(sample.text) ?? { best: 0, evidence: 0 };
      group.best = Math.max(group.best, score);
      group.evidence++;
      groups.set(sample.text, group);
    }
    return [...groups].filter(([, g]) => (prefix || g.evidence >= 2) && g.best >= 0.35)
      .map(([text, g]) => ({ text, suffix: text.slice(prefix.length), score: Math.min(1, g.best), evidence: g.evidence }))
      .sort((a, b) => b.score - a.score || b.evidence - a.evidence || a.text.localeCompare(b.text))
      .slice(0, Math.min(limit, 5));
  }
  export(): ModelData { this.prune(); return { version: 1, samples: this.samples.map(x => ({ ...x })) }; }
  /** Validate every field. Corrupt/unknown versions fail closed with no partial load. */
  restore(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false;
    const value = data as Partial<ModelData>;
    if (value.version !== 1 || !Array.isArray(value.samples) || value.samples.length > LIMITS.samples) return false;
    const samples: Sample[] = [];
    for (const s of value.samples) {
      if (!s || !safeText(s.text) || /^[\/@]/u.test(s.text.trim()) || !safeText(s.context, LIMITS.context)
        || !Number.isFinite(s.time) || s.time > this.now()
        || !Number.isInteger(s.accepted) || s.accepted < 0 || s.accepted > 100
        || !Number.isInteger(s.dismissed) || s.dismissed < 0 || s.dismissed > 100) return false;
      samples.push({ text: s.text, context: s.context, time: s.time, accepted: s.accepted, dismissed: s.dismissed });
    }
    this.samples = samples;
    this.prune();
    return true;
  }
}
