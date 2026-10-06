import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import React, { act } from 'react';
import { Suggestion } from '../src/Suggestion.js';
import type { SuggestionProps } from '../src/Suggestion.js';
import { LocalModel } from '../src/storage.js';
import { Learner } from '../src/learning.js';
import { apply } from '../src/client.js';

test('client registers a disposable public DSH slot', () => {
  let registered = false;
  const fake = { effect() {}, slots: {
    inject(name: string, cb: () => unknown) { assert.equal(name, 'conversation.input.overlay'); return cb(); },
    register(options: { id: string }, component: unknown) { registered = true; assert.equal(options.id, 'next-prompt'); assert.equal(component, Suggestion); return () => {}; },
  } };
  apply(fake as never); assert.equal(registered, true);
});

test('Tab acceptance, revision guards, IME, menu priority, modifiers and disposal', async () => {
  const dom = new JSDOM('<div data-composer-card><div id="slot"></div><div data-composer-input contenteditable="true"></div></div>', { url: 'https://test.invalid' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true });
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const model = new LocalModel('test', storage); model.enable();
  model.predictor.learn('fix login', 'run login tests');
  let input = { draft: 'run', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: [], queue: [] };
  let inserted = ''; let submissions = 0; let cursor = 3; let allowInsert = true;
  const runtime = { model, learner: new Learner(model.predictor), input: { state: { getSnapshot: () => input } },
    subscribe: () => () => {}, getSnapshot: () => 0, enable() {}, forget() { model.forget(); } };
  const actions = { captureInsertion: () => ({ start: cursor, end: cursor, draftRev: input.draftRev }),
    insertText: (text: string) => { if (!allowInsert) return false; inserted = text; return true; }, submit: () => { submissions++; } };
  const props = { runtime, useInput: (select: (x: typeof input) => unknown) => select(input), inputActions: actions } as unknown as SuggestionProps;
  const root = createRoot(window.document.getElementById('slot')!);
  const editor = window.document.querySelector('[data-composer-input]')!;
  const key = async (name: string, extra: KeyboardEventInit = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
    await act(async () => { editor.dispatchEvent(event); }); return event;
  };
  const render = async () => {
    await act(async () => { root.render(<Suggestion {...props} />); });
    await act(async () => { await new Promise(r => setTimeout(r, 140)); });
  };
  try {
    await render();
    assert.match(window.document.body.textContent!, /login tests/);
    await act(async () => {
      editor.setAttribute('tabindex', '0'); editor.textContent = 'run'; (editor as HTMLElement).focus();
      const range = window.document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      window.document.getSelection()!.removeAllRanges(); window.document.getSelection()!.addRange(range);
      window.document.dispatchEvent(new window.Event('selectionchange'));
    });
    assert.match(window.document.querySelector('[data-next-prompt-ghost]')!.textContent!, /run login tests/);
    assert.equal(editor.textContent, 'run');
    assert.equal((await key('Tab', { shiftKey: true })).defaultPrevented, false);
    assert.equal((await key('Tab', { isComposing: true })).defaultPrevented, false);
    assert.equal(inserted, '');
    editor.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.equal((await key('Tab')).defaultPrevented, false);
    editor.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
    assert.equal((await key('Tab')).defaultPrevented, false);
    await new Promise(r => setTimeout(r, 60));
    cursor = 1; assert.equal((await key('Tab')).defaultPrevented, false); cursor = 3;
    const menu = window.document.createElement('div'); menu.setAttribute('role', 'listbox'); editor.parentElement!.append(menu);
    assert.equal((await key('Tab')).defaultPrevented, false); menu.remove();
    const blocked = (e: Event) => e.preventDefault(); editor.addEventListener('keydown', blocked);
    await key('Tab'); assert.equal(inserted, ''); editor.removeEventListener('keydown', blocked);
    input = { ...input, draftRev: 2 };
    await key('Tab'); assert.equal(inserted, ''); // React still displays rev=1; live state already rev=2.
    input = { ...input, draftRev: 1 };
    allowInsert = false;
    assert.equal((await key('Tab')).defaultPrevented, false); assert.equal(inserted, '');
    allowInsert = true;
    assert.equal((await key('Tab')).defaultPrevented, true);
    assert.equal(inserted, ' login tests'); assert.equal(submissions, 0);
    inserted = ''; input = { ...input, draftRev: 2 }; await render();
    const pick = window.document.querySelector('[aria-label^="接受预测"]')!;
    await act(async () => { pick.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    assert.equal(inserted, ' login tests'); assert.equal(submissions, 0);
    inserted = ''; input = { ...input, draftRev: 3 }; await render();
    assert.equal((await key('Escape')).defaultPrevented, true);
    await key('Tab'); assert.equal(inserted, '');
    inserted = ''; await act(async () => { root.unmount(); });
    await key('Tab'); assert.equal(inserted, '');
  } finally { dom.window.close(); }
});
