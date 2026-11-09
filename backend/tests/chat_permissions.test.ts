import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS } from '../src/permissions';

const preview = readFileSync(
  join(process.cwd(), 'prisma', 'permission-previews', 'sprint8_chat_permissions_preview.sql'),
  'utf8'
);
const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');

describe('Sprint 8 chat permissions', () => {
  it('keeps chat.view in the canonical backend permission set', () => {
    expect(PERMISSIONS.CHAT_VIEW).toBe('chat.view');
    expect(ALL_PERMISSIONS).toContain(PERMISSIONS.CHAT_VIEW);
  });

  it('keeps Sprint 12K chat creation and pin keys in the canonical set', () => {
    expect(PERMISSIONS.CHAT_CREATE_DIRECT).toBe('chat.create_direct');
    expect(PERMISSIONS.CHAT_CREATE_DEPARTMENT).toBe('chat.create_department');
    expect(PERMISSIONS.CHAT_CREATE_COMPANY_ANNOUNCEMENT).toBe('chat.create_company_announcement');
    expect(PERMISSIONS.CHAT_PIN).toBe('chat.pin');
    for (const key of [
      PERMISSIONS.CHAT_CREATE_DIRECT,
      PERMISSIONS.CHAT_CREATE_DEPARTMENT,
      PERMISSIONS.CHAT_CREATE_COMPANY_ANNOUNCEMENT,
      PERMISSIONS.CHAT_PIN,
    ]) {
      expect(ALL_PERMISSIONS).toContain(key);
    }
  });

  it('defines chat.view for every future staff role but not Admin', () => {
    for (const role of [
      'HR Manager',
      'Department Manager',
      'Employee',
      'Accountant',
      'Finance Manager',
      'Purchasing Officer',
    ]) {
      const roleLine = seed.split('\n').find((line) => line.includes(`name: '${role}'`));
      expect(roleLine).toContain("'chat.view'");
    }
    const adminLine = seed.split('\n').find((line) => line.includes("name: 'Admin'"));
    expect(adminLine).not.toContain("'chat.view'");
    expect(seed).toContain('const managedChatPermissions = new Set([');
    expect(seed).toContain("'chat.create_direct'");
    expect(seed).toContain("'chat.pin'");
  });

  it('keeps the staging preview read-only and preserves unrelated order', () => {
    const executableSql = preview
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(preview).toContain("('Employee', true)");
    expect(preview).toContain("('Accountant', true)");
    expect(preview).toContain("('Admin', false)");
    expect(preview).toContain('WITH ORDINALITY');
    expect(executableSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });
});
