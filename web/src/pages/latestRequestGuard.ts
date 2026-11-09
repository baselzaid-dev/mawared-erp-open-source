export type LatestRequestGuard = {
  begin(): number;
  isCurrent(requestId: number): boolean;
  invalidate(): void;
};

/**
 * Issues monotonically increasing request identifiers so UI code can ignore
 * responses from an older request after a newer selection (or dialog close).
 * Kept framework-agnostic so stale-response behavior is testable without a DOM.
 */
export function createLatestRequestGuard(): LatestRequestGuard {
  let currentRequestId = 0;

  return {
    begin() {
      currentRequestId += 1;
      return currentRequestId;
    },
    isCurrent(requestId) {
      return requestId === currentRequestId;
    },
    invalidate() {
      currentRequestId += 1;
    },
  };
}
