// Small shared stores. The playhead changes every animation frame during
// playback, so it lives outside React state; only components that draw it
// subscribe.

import { useSyncExternalStore } from "react";

function createStore(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set: (v) => {
      const next = typeof v === "function" ? v(value) : v;
      if (next === value) return;
      value = next;
      for (const s of subs) s();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const playhead = createStore(0);
export const playing = createStore(false);

export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const mediaUrl = (path) => `cutroom-media://local/${encodeURIComponent(path)}`;

export const api = window.cutroom;
