/**
 * Minimal browser environment for mounting React components under node:test (happy-dom), plus tiny
 * helpers for typing, clicking and waiting. Import this module BEFORE react-dom/client.
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/', width: 1024, height: 768 });

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLButtonElement: win.HTMLButtonElement,
  Node: win.Node,
  Element: win.Element,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  MutationObserver: win.MutationObserver,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  },
};

for (const [k, v] of Object.entries(globals)) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom-style helpers some components call
const elProto = win.Element.prototype as unknown as Record<string, unknown>;
if (!elProto.scrollIntoView) elProto.scrollIntoView = () => {};
if (!elProto.scrollTo) elProto.scrollTo = () => {};

export const domWindow = win;

/** Sets an input/textarea value the way a user typing would, so React's onChange fires. */
export function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  caret = value.length
): void {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
}

export function pressKey(el: Element, key: string): void {
  el.dispatchEvent(
    new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event
  );
}

export function mouseDown(el: Element): void {
  el.dispatchEvent(
    new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }) as unknown as Event
  );
}

export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export async function closeDom(): Promise<void> {
  await win.happyDOM.close();
}
