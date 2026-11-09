import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260720000100_rc2_chat_enhancements', 'migration.sql'),
  'utf8',
);

describe('Sprint 12K M10 chat enhancements migration', () => {
  it('adds announcement shape, repliesEnabled, replyTo, and ChatPinnedMessage with restrictive FKs', () => {
    expect(sql).toContain('repliesEnabled');
    expect(sql).toContain("'announcement'");
    expect(sql).toContain('replyToMessageId');
    expect(sql).toContain('CREATE TABLE "ChatPinnedMessage"');
    expect(sql).toContain('ChatPinnedMessage_conversationId_companyId_fkey');
    expect(sql).toContain('ChatPinnedMessage_messageId_companyId_fkey');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('contains no destructive wipe of chat history', () => {
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });
});
