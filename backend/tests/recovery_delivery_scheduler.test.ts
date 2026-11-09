import { describe, expect, it, vi } from 'vitest';
import {
  CapturingRecoveryDeliveryAdapter,
  RecoveryDeliveryScheduler,
} from '../src/credentialRecovery';
import { mintRecoveryTokenMaterial } from '../src/credentialRecovery/tokenCrypto';

const TOKEN_PEPPER = 'e3-scheduler-test-pepper-32chars-min!!';
const ENV_BINDING = 'test:e3-scheduler';

describe('RecoveryDeliveryScheduler timeout truthfulness', () => {
  it('leaves status pending on wait-budget timeout and ignores late adapter success', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    let finish: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const originalSend = adapter.send.bind(adapter);
    adapter.send = vi.fn(async (input) => {
      await gate;
      return originalSend(input);
    });

    const recordDeliveryStatus = vi.fn(async () => ({
      ok: true as const,
      value: { recoveryRequestId: 'rr', deliveryStatus: 'dispatched' as const },
    }));
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 30 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-timeout-1',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-timeout-1',
    });

    await scheduler.waitForIdle();
    expect(scheduler.lastOutcomes).toEqual(['pending_timeout']);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();

    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
    expect(scheduler.containedErrors).toHaveLength(0);
  });

  it('contains late adapter rejection after timeout without unhandled rejection', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    let rejectSend: ((error: Error) => void) | null = null;
    adapter.send = vi.fn(async () => new Promise<never>((_, reject) => {
      rejectSend = reject;
    }));

    const recordDeliveryStatus = vi.fn(async () => ({
      ok: true as const,
      value: { recoveryRequestId: 'rr', deliveryStatus: 'dispatched' as const },
    }));
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 20 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-timeout-reject',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-timeout-reject',
    });

    await scheduler.waitForIdle();
    expect(scheduler.lastOutcomes).toEqual(['pending_timeout']);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();

    rejectSend?.(new Error('late smtp failure'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
    expect(scheduler.containedErrors).toHaveLength(0);
  });

  it('records failed only for confirmed adapter failure before idle', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    adapter.setNextStatus('failed');
    const recordDeliveryStatus = vi.fn(async () => ({
      ok: true as const,
      value: { recoveryRequestId: 'rr', deliveryStatus: 'dispatched' as const },
    }));
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 1_000 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-failed-1',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-failed-1',
    });

    await scheduler.waitForIdle();
    expect(scheduler.lastOutcomes).toEqual(['failed']);
    expect(recordDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(recordDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryStatus: 'failed' }),
    );
  });

  it('does not auto-schedule a second delivery after timeout', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    let finish: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    adapter.send = vi.fn(async () => {
      await gate;
      return { deliveryStatus: 'dispatched' as const };
    });
    const recordDeliveryStatus = vi.fn(async () => ({ ok: true as const, value: {
      recoveryRequestId: 'rr-once',
      deliveryStatus: 'dispatched',
    } }));
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 20 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-once',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-once',
    });
    await scheduler.waitForIdle();
    expect(adapter.send).toHaveBeenCalledTimes(1);
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('records status_persistence_failed when recordDeliveryStatus resolves ok:false after dispatch', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    const recordDeliveryStatus = vi.fn(async () => ({
      ok: false as const,
      reason: 'audit_rejected' as const,
    }));
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 1_000 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-ok-false-dispatch',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-ok-false-dispatch',
    });

    await scheduler.waitForIdle();
    expect(scheduler.lastOutcomes).toEqual(['status_persistence_failed']);
    expect(scheduler.lastOutcomes).not.toContain('dispatched');
    expect(recordDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(scheduler.containedEvidence).toEqual([
      expect.objectContaining({
        kind: 'status_persistence_failed',
        recoveryRequestId: 'rr-ok-false-dispatch',
        adapterOutcome: 'dispatched',
        reasonCode: 'audit_rejected',
      }),
    ]);
    expect(JSON.stringify(scheduler.containedEvidence)).not.toContain('owner-email');
    expect(scheduler.containedErrors).toHaveLength(0);
  });

  it('records status_persistence_failed when recordDeliveryStatus resolves ok:false after adapter failed', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    adapter.setNextStatus('failed');
    const recordDeliveryStatus = vi.fn(async () => ({
      ok: false as const,
      reason: 'concurrent_conflict' as const,
    }));
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 1_000 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-ok-false-failed',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-ok-false-failed',
    });

    await scheduler.waitForIdle();
    expect(scheduler.lastOutcomes).toEqual(['status_persistence_failed']);
    expect(scheduler.lastOutcomes).not.toContain('failed');
    expect(scheduler.containedEvidence[0]).toMatchObject({
      kind: 'status_persistence_failed',
      adapterOutcome: 'failed',
      reasonCode: 'concurrent_conflict',
    });
    expect(scheduler.containedErrors).toHaveLength(0);
  });

  it('records status_persistence_failed when recordDeliveryStatus throws', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    const recordDeliveryStatus = vi.fn(async () => {
      throw new Error('db down');
    });
    const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 1_000 });
    const minted = mintRecoveryTokenMaterial(
      {
        principalDomain: 'company_primary_owner',
        purpose: 'password_reset',
        environmentBinding: ENV_BINDING,
      },
      { tokenPepper: TOKEN_PEPPER },
    );

    scheduler.schedule({
      adapter,
      service: { recordDeliveryStatus },
      issued: {
        recoveryRequestId: 'rr-throw-persist',
        deliverySecret: minted.rawToken,
        expiresAt: new Date('2026-07-30T12:15:00.000Z'),
      },
      recipientRef: 'owner-email:c1:u1',
      template: 'company_owner_password_reset',
      requestId: 'req-throw-persist',
    });

    await scheduler.waitForIdle();
    expect(scheduler.lastOutcomes).toEqual(['status_persistence_failed']);
    expect(scheduler.containedEvidence[0]).toMatchObject({
      kind: 'status_persistence_failed',
      reasonCode: 'persist_threw',
    });
    expect(scheduler.containedErrors).toHaveLength(0);
  });
});
