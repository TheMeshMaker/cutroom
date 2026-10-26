// Small shared stores. The playhead changes every animation frame during
// playback, so it lives outside React state; only components that draw it
// subscribe.

import { useSyncExternalStore } from "react";

export function createStore(initial) {
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
// Exact still currently shown by the player (url), for scopes when paused.
export const stillFrame = createStore(null);
// Live audio levels per track id (0..1 peak) and the master, from Web Audio.
export const meters = createStore({});
// The player's media elements by track id, for scopes during playback.
export const mediaElements = new Map();
// Clip id whose grade is temporarily bypassed (Color page before/after).
export const gradeBypass = createStore(null);
// The source monitor's controls while it is open ({ toggle, time, seek }).
export const sourceControl = { current: null };

export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const mediaUrl = (path) => `cutroom-media://local/${encodeURIComponent(path)}`;

export const api = window.cutroom;
