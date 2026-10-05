import { useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client';

interface GhostProps { anchor: RefObject<HTMLElement>; prefix: string; suffix: string; revision: number; actions: InputActions }

/** Mirrors only pure text in a pointer-inert layer; the editor document never contains the suggestion. */
export function Ghost({ anchor, prefix, suffix, revision, actions }: GhostProps) {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]');
    const editor = card?.querySelector<HTMLElement>('[data-composer-input]');
    if (!card || !editor) return;
    const measure = () => {
      const selection = document.getSelection();
      const span = actions.captureInsertion();
      if (document.activeElement !== editor || !selection?.isCollapsed || !selection.anchorNode
        || !editor.contains(selection.anchorNode) || span.start !== prefix.length || span.end !== span.start
        || span.draftRev !== revision || editor.hasAttribute('data-composer-composing')) { setStyle(undefined); return; }
      const box = editor.getBoundingClientRect();
      const parentBox = editor.parentElement?.getBoundingClientRect() ?? box;
      const css = getComputedStyle(editor);
      // The scrollport can clip the first lines of a growing composer.
      const topClip = Math.max(0, parentBox.top - box.top);
      const bottomClip = Math.max(0, box.bottom - parentBox.bottom);
      setStyle({ position: 'fixed', pointerEvents: 'none', userSelect: 'none', zIndex: 10,
        left: box.left, top: box.top, width: box.width, height: box.height,
        boxSizing: css.boxSizing === 'border-box' ? 'border-box' : 'content-box', padding: css.padding, border: 'none', margin: 0,
        fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight,
        fontStyle: css.fontStyle, lineHeight: css.lineHeight, letterSpacing: css.letterSpacing,
        wordSpacing: css.wordSpacing, textIndent: css.textIndent, textAlign: css.textAlign as CSSProperties['textAlign'],
        tabSize: css.tabSize, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        clipPath: `inset(${topClip}px 0 ${bottomClip}px 0)`, overflow: 'hidden',
      });
    };
    measure();
    document.addEventListener('selectionchange', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    editor.addEventListener('focus', measure); editor.addEventListener('blur', measure);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(editor);
    return () => {
      observer?.disconnect(); document.removeEventListener('selectionchange', measure);
      window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true);
      editor.removeEventListener('focus', measure); editor.removeEventListener('blur', measure);
    };
  }, [anchor, prefix, suffix, revision, actions]);
  return style ? createPortal(<div aria-hidden="true" data-next-prompt-ghost style={style}>
    <span style={{ visibility: 'hidden' }}>{prefix}</span><span style={{ color: '#89929e' }}>{suffix}</span>
  </div>, document.body) : null;
}
