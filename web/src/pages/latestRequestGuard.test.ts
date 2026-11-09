import { describe, expect, it } from 'vitest';
import { createLatestRequestGuard } from './latestRequestGuard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('approval details latest-request guard', () => {
  it('ignores a slower response after a newer approval was opened', async () => {
    const guard = createLatestRequestGuard();
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];

    const firstRequestId = guard.begin();
    const firstTask = first.promise.then((value) => {
      if (guard.isCurrent(firstRequestId)) applied.push(value);
    });

    const secondRequestId = guard.begin();
    const secondTask = second.promise.then((value) => {
      if (guard.isCurrent(secondRequestId)) applied.push(value);
    });

    second.resolve('second');
    await secondTask;
    first.resolve('first');
    await firstTask;

    expect(applied).toEqual(['second']);
  });

  it('invalidates an in-flight response when the details dialog closes', () => {
    const guard = createLatestRequestGuard();
    const requestId = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(requestId)).toBe(false);
  });
});
