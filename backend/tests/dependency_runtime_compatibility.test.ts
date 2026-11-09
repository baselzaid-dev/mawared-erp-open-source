import { createRequire } from 'node:module';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const localTempDirs: string[] = [];

afterEach(() => {
  while (localTempDirs.length > 0) {
    const dir = localTempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function exceljsRoot(): string {
  return path.dirname(require.resolve('exceljs/package.json'));
}

function resolveFromExceljs(specifier: string): string {
  return require.resolve(specifier, { paths: [exceljsRoot()] });
}

function packageJsonFrom(moduleId: string, fromPaths?: string[]): {
  name?: string;
  version?: string;
  engines?: { node?: string };
} {
  const resolved = fromPaths?.length
    ? require.resolve(`${moduleId}/package.json`, { paths: fromPaths })
    : require.resolve(`${moduleId}/package.json`);
  return require(resolved);
}

function minimatchFn(mod: unknown): (str: string, pattern: string) => boolean {
  if (typeof mod === 'function') return mod as (str: string, pattern: string) => boolean;
  const named = (mod as { minimatch?: unknown })?.minimatch;
  if (typeof named === 'function') return named as (str: string, pattern: string) => boolean;
  throw new Error('minimatch export is neither callable nor { minimatch }');
}

describe('dependency runtime compatibility', () => {
  it('root minimatch expands brace patterns without TypeError', () => {
    const mm = require('minimatch');
    const fn = minimatchFn(mm);
    expect(fn('a.js', '{a,b}.js')).toBe(true);
    expect(fn('b.js', '{a,b}.js')).toBe(true);
    expect(fn('c.js', '{a,b}.js')).toBe(false);
  });

  it('root minimatch expands numeric brace ranges', () => {
    const mm = require('minimatch');
    const fn = minimatchFn(mm);
    expect(fn('file1.txt', 'file{1..3}.txt')).toBe(true);
    expect(fn('file3.txt', 'file{1..3}.txt')).toBe(true);
    expect(fn('file4.txt', 'file{1..3}.txt')).toBe(false);
  });

  it('readdir-glob/archiver nested minimatch resolves brace patterns', () => {
    const readdirGlobPath = resolveFromExceljs('readdir-glob');
    const nestedContext = path.dirname(readdirGlobPath);
    const nestedMinimatchPath = require.resolve('minimatch', { paths: [nestedContext] });
    const nestedMinimatchPkgPath = require.resolve('minimatch/package.json', {
      paths: [path.dirname(nestedMinimatchPath)],
    });
    const nestedMinimatchPkg = require(nestedMinimatchPkgPath) as { name?: string; version?: string };
    const nestedBracePath = require.resolve('brace-expansion', {
      paths: [path.dirname(nestedMinimatchPkgPath)],
    });
    const nestedBracePkgPath = require.resolve('brace-expansion/package.json', {
      paths: [path.dirname(nestedMinimatchPkgPath)],
    });
    const nestedBrace = require(nestedBracePath) as { expand?: unknown };
    const nestedBracePkg = require(nestedBracePkgPath) as { version?: string };

    // Bound the asserted package.json to the exact nested module that was loaded.
    expect(nestedMinimatchPath.startsWith(path.dirname(nestedMinimatchPkgPath) + path.sep)).toBe(true);
    expect(nestedMinimatchPkg.name).toBe('minimatch');
    expect(nestedMinimatchPkg.version).toBe('11.0.5');
    expect(nestedBracePkg.version).toBe('5.0.12');
    expect(typeof nestedBrace).toBe('object');
    expect(typeof nestedBrace.expand).toBe('function');

    const mm = require(nestedMinimatchPath);
    const fn = minimatchFn(mm);
    expect(fn('a.js', '{a,b}.js')).toBe(true);
    expect(fn('c.js', '{a,b}.js')).toBe(false);
    expect(fn('file2.txt', 'file{1..3}.txt')).toBe(true);
  });

  it('brace-expansion CommonJS shape matches the installed minimatch consumer', () => {
    const brace = require('brace-expansion');
    const bracePkg = packageJsonFrom('brace-expansion');
    const mm = require('minimatch');
    const mmPkg = packageJsonFrom('minimatch');

    // minimatch 10+ requires the named-export object shape (brace.expand), not a callable default.
    expect(bracePkg.version).toBe('5.0.12');
    expect(typeof brace).toBe('object');
    expect(typeof brace.expand).toBe('function');
    expect(typeof mm).toBe('object');
    expect(typeof mm.minimatch).toBe('function');
    expect(mmPkg.version).toMatch(/^11\./);

    // Bound representative expansion (DoS regression): patched API exposes length bounds.
    expect(typeof brace.EXPANSION_MAX).toBe('number');
    expect(typeof brace.EXPANSION_MAX_LENGTH).toBe('number');
    const bounded = brace.expand('x{1..3}', { max: 3 });
    expect(bounded).toEqual(['x1', 'x2', 'x3']);
  });

  it('keeps the ExcelJS stream dependencies compatible', () => {
    // ExcelJS stream writer requires archiver 5.x (StreamBuf-compatible normalizeInputSource).
    expect(packageJsonFrom('archiver', [exceljsRoot()]).version).toMatch(/^5\./);
    // Keep the native archiver-utils glob major (7.x); do not force glob 10/13 under archiver 5.
    expect(packageJsonFrom('glob', [exceljsRoot()]).version).toMatch(/^7\./);

    // Guard: no legacy rimraf/fstream callback path should remain under exceljs.
    expect(() => require.resolve('rimraf')).toThrow();
    expect(() => require.resolve('fstream')).toThrow();
  });

  it('archiver brace-glob smoke test produces a valid zip without minimatch/brace failures', async () => {
    const archiver = require(resolveFromExceljs('archiver'));
    const dir = mkdtempSync(path.join(tmpdir(), 'mawared-arch-'));
    localTempDirs.push(dir);
    writeFileSync(path.join(dir, 'a.js'), 'a');
    writeFileSync(path.join(dir, 'b.js'), 'b');
    writeFileSync(path.join(dir, 'c.js'), 'c');

    const outPath = path.join(dir, 'out.zip');
    const output = createWriteStream(outPath);
    const archive = archiver('zip');
    const warnings: Error[] = [];
    archive.on('warning', (err: Error) => warnings.push(err));

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', reject);
      output.on('error', reject);
    });

    archive.pipe(output);
    archive.glob('{a,b}.js', { cwd: dir });
    await archive.finalize();
    await done;

    expect(warnings).toEqual([]);
    const bytes = readFileSync(outPath);
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(bytes.length).toBeGreaterThan(22);
  });
});
