import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from './sessionMemory';

describe('memory-only session storage', () => {
  afterEach(() => sessionMemory.clear());

  it('keeps tokens in process memory and returns defensive copies', () => {
    const input = { accessToken: 'access-value', refreshToken: 'refresh-value' }; // security-scan-allow: memory-only test fixture
    sessionMemory.set(input);
    input.accessToken = 'changed';

    const first = sessionMemory.get();
    expect(first).toEqual({ accessToken: 'access-value', refreshToken: 'refresh-value' }); // security-scan-allow: memory-only test fixture
    if (first) first.refreshToken = 'changed-again'; // security-scan-allow: mutation test fixture
    expect(sessionMemory.get()?.refreshToken).toBe('refresh-value');
  });

  it('notifies subscribers when a session is cleared', () => {
    const listener = vi.fn();
    const unsubscribe = sessionMemory.subscribe(listener);
    sessionMemory.set({ accessToken: 'access', refreshToken: 'refresh' });
    sessionMemory.clear();
    unsubscribe();

    expect(listener).toHaveBeenLastCalledWith(null);
  });
});
