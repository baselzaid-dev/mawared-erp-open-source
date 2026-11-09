import type { SessionTokens } from './types';

let current: SessionTokens | null = null;
const listeners = new Set<(tokens: SessionTokens | null) => void>();

function notify(): void {
  for (const listener of listeners) listener(current ? { ...current } : null);
}

export const sessionMemory = {
  get(): SessionTokens | null {
    return current ? { ...current } : null;
  },

  set(tokens: SessionTokens): void {
    current = { ...tokens };
    notify();
  },

  clear(): void {
    current = null;
    notify();
  },

  subscribe(listener: (tokens: SessionTokens | null) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
