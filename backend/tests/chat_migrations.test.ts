import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260710000300_chat_foundation', 'migration.sql'),
  'utf8'
);

describe('Sprint 8 chat migration', () => {
  it('creates all three chat tables with tenant-safe restrictive relationships', () => {
    expect(sql).toContain('CREATE TABLE "ChatConversation"');
    expect(sql).toContain('CREATE TABLE "ChatParticipant"');
    expect(sql).toContain('CREATE TABLE "ChatMessage"');
    expect(sql).toContain('ChatConversation_departmentId_companyId_fkey');
    expect(sql).toContain('ChatParticipant_conversationId_companyId_fkey');
    expect(sql).toContain('ChatParticipant_userId_companyId_fkey');
    expect(sql).toContain('ChatMessage_conversationId_companyId_fkey');
    expect(sql).toContain('ChatMessage_senderUserId_companyId_fkey');
    expect(sql.match(/ON DELETE RESTRICT/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it('adds uniqueness, paging indexes, validation checks, and RLS', () => {
    expect(sql).toContain('ChatConversation_companyId_directKey_key');
    expect(sql).toContain('ChatConversation_companyId_departmentId_type_key');
    expect(sql).toContain('ChatParticipant_conversationId_userId_key');
    expect(sql).toContain('ChatMessage_conversationId_createdAt_id_idx');
    expect(sql).toContain('ChatConversation_type_check');
    expect(sql).toContain('ChatConversation_type_shape_check');
    expect(sql).toContain('ChatMessage_body_length_check');
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)?.length).toBe(3);
  });

  it('contains no destructive operation or cascading history deletion', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });
});
