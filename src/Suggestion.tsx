import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionRuntime } from './runtime.js';
import { Ghost } from './Ghost.js';

export type SuggestionProps = PropsRuntime<'conversation.input.overlay'> & { runtime: SessionRuntime };
/** A visible suggestion accepts into the draft only. Enter remains entirely DSH-owned. */
export function Suggestion({ runtime, useInput, inputActions }: SuggestionProps) {
  const input = useInput(s => s);
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [dismissed, setDismissed] = useState('');
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { model, learner } = runtime;
  const eligible = model.enabled && input.phase === 'plain' && !input.occurrences.length
    && !input.attachmentIds.length && !/(?:^|\s)[/@]\S*$/u.test(input.draft);
  const context = learner.context();
  const localCandidate = eligible && ready ? model.predictor.predict(context, input.draft, 1)[0] : undefined;
  const generated = runtime.generated;
  const modelCandidate = eligible && ready && generated?.context === context && generated.prefix === input.draft
    && generated.draftRev === input.draftRev ? { text: generated.text, suffix: generated.text.slice(input.draft.length) } : undefined;
  const candidate = localCandidate ?? modelCandidate;
  const identity = `${input.draftRev}:${candidate?.text ?? ''}`;
  const shown = candidate !== undefined && dismissed !== identity;
  useEffect(() => {
    setReady(false);
    const timer = setTimeout(() => { setReady(true); }, 120);
    return () => { clearTimeout(timer); };
  }, [input.draftRev, runtime]);
  useEffect(() => {
    if (!eligible || !ready || localCandidate || !runtime.modelPredictions || !runtime.generator) return;
    const timer = setTimeout(() => { void runtime.predictWithModel(input.draft); }, 600);
    return () => { clearTimeout(timer); runtime.cancelGeneration(); };
  }, [runtime, runtime.modelPredictions, eligible, ready, localCandidate?.text, context, input.draft, input.draftRev]);
  useEffect(() => {
    if (!shown || !candidate) return;
    const card = root.current?.closest('[data-composer-card]');
    if (!card) return;
    let composing = false;
    let until = 0;
    const start = () => { composing = true; };
    const end = () => { composing = false; until = Date.now() + 50; };
    const accept = (): boolean => {
      const live = runtime.input.state.getSnapshot();
      if (!model.enabled || live.draftRev !== input.draftRev || live.phase !== 'plain'
        || live.draft !== input.draft || live.occurrences.length || live.attachmentIds.length) return false;
      const span = inputActions.captureInsertion();
      if (span.start !== live.draft.length || span.end !== span.start || span.draftRev !== live.draftRev) return false;
      if (!inputActions.insertText(candidate.suffix, span)) return false;
      model.predictor.feedback(candidate.text, 'accepted'); model.save();
      setDismissed(identity); return true;
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing || Date.now() < until
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      const target = event.target;
      if (!(target instanceof Element) || !card.contains(target)
        || !target.closest('[data-composer-input][contenteditable="true"]')) return;
      if (target.closest('[data-composer-composing]')) return;
      if (card.querySelector('[role="listbox"]')) return;
      if (event.key === 'Tab' && accept()) event.preventDefault();
      if (event.key === 'Escape') {
        model.predictor.feedback(candidate.text, 'dismissed'); model.save();
        setDismissed(identity); event.preventDefault();
      }
    };
    // Bubble after Lexical: DSH's trigger menu gets the first refusal.
    card.addEventListener('compositionstart', start);
    card.addEventListener('compositionend', end);
    document.addEventListener('keydown', keydown);
    return () => {
      card.removeEventListener('compositionstart', start);
      card.removeEventListener('compositionend', end);
      document.removeEventListener('keydown', keydown);
    };
  }, [shown, candidate?.text, input.draftRev, identity, runtime, inputActions, tick]);

  const buttonAccept = () => {
    if (!shown || !candidate) return;
    if (root.current?.closest('[data-composer-card]')?.querySelector('[data-composer-composing]')) return;
    const live = runtime.input.state.getSnapshot();
    const span = inputActions.captureInsertion();
    if (model.enabled && live.phase === 'plain' && live.draftRev === input.draftRev
      && live.draft === input.draft && !live.occurrences.length && !live.attachmentIds.length
      && span.start === live.draft.length && span.end === span.start
      && inputActions.insertText(candidate.suffix, span)) {
      model.predictor.feedback(candidate.text, 'accepted'); model.save(); setDismissed(identity);
    }
  };
  return <div ref={root} data-next-prompt style={{ position: 'absolute', bottom: '100%', left: 0, right: 0,
    padding: '6px 10px', border: '1px solid #8885', borderRadius: 8, background: 'var(--dsh-bg, Canvas)',
    color: 'var(--dsh-fg, CanvasText)', fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    {shown && <Ghost anchor={root} prefix={input.draft} suffix={candidate.suffix} revision={input.draftRev} actions={inputActions} />}
    {shown ? <>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={buttonAccept}
        style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={candidate.text} aria-label={`接受预测：${candidate.text}`}>{candidate.suffix}</button>
      <span>Tab 接受 · Esc 忽略</span>
    </> : <span style={{ flex: 1 }}>{model.enabled ? '下一提示 · 本地学习中' : '下一提示 · 学习已关闭'}</span>}
    <button type="button" onClick={() => { if (model.enabled) runtime.forget(); else runtime.enable(); setTick(x => x + 1); }}>
      {model.enabled ? '关闭并清除' : '开启本会话学习'}
    </button>
    {model.enabled && runtime.generator && <label title="启用后会将本会话上下文、草稿及相关学习样本发送给 DSH 默认模型，可能产生用量。">
      <input type="checkbox" checked={runtime.modelPredictions} onChange={e => runtime.setModelPredictions(e.target.checked)} />
      模型预测（发送上下文）
    </label>}
    {runtime.generationStatus === 'pending' && <span role="status">正在预测…</span>}
    {runtime.generationStatus === 'unavailable' && <span role="status">模型暂不可用，保留本地建议</span>}
    {model.error && <span role="status">{model.error}</span>}
  </div>;
}
