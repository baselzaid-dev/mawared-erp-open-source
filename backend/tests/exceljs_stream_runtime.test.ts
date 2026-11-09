import ExcelJS from 'exceljs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const localTempDirs: string[] = [];

afterEach(() => {
  while (localTempDirs.length > 0) {
    const dir = localTempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ExcelJS streaming archive/unzipper runtime', () => {
  it('WorkbookWriter reaches archiver and produces a reopenable workbook', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mawared-xlsx-writer-'));
    localTempDirs.push(dir);
    const outPath = path.join(dir, 'stream-writer.xlsx');

    const processWarnings: string[] = [];
    const onWarning = (warning: Error) => {
      processWarnings.push(String(warning));
    };
    process.on('warning', onWarning);

    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: outPath,
        useSharedStrings: true,
        useStyles: true,
      });
      const sheet = workbook.addWorksheet('StreamSheet');
      sheet.addRow(['Name', 'Amount', 'When', 'Formula']).commit();
      const when = new Date('2026-07-01T00:00:00.000Z');
      sheet.addRow(['Alpha', 12.5, when, { formula: 'B2*2', result: 25 }]).commit();
      await sheet.commit();
      await workbook.commit();

      const bytes = readFileSync(outPath);
      expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');

      const reopen = new ExcelJS.Workbook();
      await reopen.xlsx.readFile(outPath);
      const reopened = reopen.getWorksheet('StreamSheet');
      expect(reopened).toBeTruthy();
      expect(reopened!.getCell('A1').value).toBe('Name');
      expect(reopened!.getCell('A2').value).toBe('Alpha');
      expect(reopened!.getCell('B2').value).toBe(12.5);
      expect(reopened!.getCell('C2').value).toBeInstanceOf(Date);
      expect(reopened!.getCell('D2').value).toEqual({ formula: 'B2*2', result: 25 });

      const warningBlob = processWarnings.join('\n');
      expect(warningBlob).not.toMatch(/archiver|readdir-glob|minimatch|brace-expansion|expand is not a function/i);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('WorkbookReader reaches unzipper and emits worksheets/rows', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mawared-xlsx-reader-'));
    localTempDirs.push(dir);
    const outPath = path.join(dir, 'stream-reader.xlsx');

    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: outPath,
      useSharedStrings: true,
    });
    const sheet = writer.addWorksheet('ReaderSheet');
    sheet.addRow(['Code', 'Qty']).commit();
    sheet.addRow(['SKU-1', 3]).commit();
    sheet.addRow(['SKU-2', 7]).commit();
    await sheet.commit();
    await writer.commit();

    const reader = new ExcelJS.stream.xlsx.WorkbookReader(outPath, {
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      entries: 'ignore',
    });

    const sheetNames: string[] = [];
    const rows: unknown[][] = [];
    const errors: Error[] = [];
    const readerEvents = reader as ExcelJS.stream.xlsx.WorkbookReader & {
      on(event: 'error', listener: (err: Error) => void): void;
    };
    readerEvents.on('error', (err: Error) => errors.push(err));

    for await (const worksheet of reader) {
      sheetNames.push(String((worksheet as { name?: string }).name ?? ''));
      for await (const row of worksheet) {
        rows.push((row as { values: unknown[] }).values);
      }
    }

    expect(errors).toEqual([]);
    expect(sheetNames).toContain('ReaderSheet');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const flattened = rows.flat().map(String);
    expect(flattened).toEqual(expect.arrayContaining(['Code', 'Qty', 'SKU-1', 'SKU-2']));
    expect(flattened.join(' ')).not.toMatch(/Cannot find module|aws-sdk|optional dependency/i);
  });
});
