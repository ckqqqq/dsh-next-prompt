import { Predictor } from './engine.js';

export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
/** Per-session isolation. Raw session IDs are not prompt content; no global cross-project model. */
export class LocalModel {
  readonly predictor = new Predictor();
  enabled = false;
  error = '';
  readonly key: string;
  constructor(sessionId: string, private readonly storage?: StoragePort) {
    this.key = `dsh-next-prompt:v1:${encodeURIComponent(sessionId)}`;
    this.reload();
  }
  reload(): void {
    this.enabled = false;
    this.predictor.clear();
    this.error = '';
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return;
      if (raw.length > 1_000_000) throw new Error('oversize model');
      const data: unknown = JSON.parse(raw);
      if (!this.predictor.restore(data)) throw new Error('invalid model');
      this.enabled = true;
    } catch { this.error = '本地学习数据无法读取；已暂停学习。'; }
  }
  enable(): void { this.enabled = true; this.save(); }
  save(): void {
    if (!this.enabled) return;
    try {
      if (!this.storage) throw new Error('unavailable storage');
      this.storage.setItem(this.key, JSON.stringify(this.predictor.export()));
      this.error = '';
    } catch { this.error = '无法保存；本次学习仅保留在内存。'; }
  }
  /** Disable and remove data; if deletion fails report it explicitly. */
  forget(): void {
    this.enabled = false;
    this.predictor.clear();
    try { this.storage?.removeItem(this.key); this.error = ''; }
    catch { this.error = '内存已清除，但本地存储删除失败；请清除站点数据。'; }
  }
}
