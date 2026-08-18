import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeExtractZip } from './zip.js';

/**
 * Builds a minimal valid (STORE-only) zip file byte-for-byte, bypassing
 * AdmZip's own writer — which sanitizes "../" segments out of entry names
 * on write, making it impossible to use for constructing a genuinely
 * malicious zip-slip fixture. Real attacker-crafted zips don't go through
 * that sanitization, so the extractor is what has to catch this.
 */
function buildRawZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    const localEntry = Buffer.concat([local, nameBuf, data]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localDir = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(localDir.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localDir, centralDir, eocd]);
}

let workDir: string;
let zipPath: string;
let destDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'portside-zip-test-'));
  zipPath = path.join(workDir, 'input.zip');
  destDir = path.join(workDir, 'extracted');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('safeExtractZip', () => {
  it('extracts a well-formed zip', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html></html>'));
    zip.addFile('nested/app.js', Buffer.from('console.log(1)'));
    zip.writeZip(zipPath);

    safeExtractZip(zipPath, destDir);

    expect(readFileSync(path.join(destDir, 'index.html'), 'utf8')).toBe('<html></html>');
    expect(readFileSync(path.join(destDir, 'nested', 'app.js'), 'utf8')).toBe('console.log(1)');
  });

  it('rejects a zip-slip entry that escapes the destination directory', () => {
    writeFileSync(zipPath, buildRawZip([{ name: '../../evil.txt', data: Buffer.from('pwned') }]));

    expect(() => safeExtractZip(zipPath, destDir)).toThrow(/resolves outside/);
    expect(existsSync(path.join(workDir, 'evil.txt'))).toBe(false);
  });

  it('rejects an absolute-path entry', () => {
    const zip = new AdmZip();
    // AdmZip normalizes leading slashes on some platforms; use a Windows-style
    // absolute path, which it preserves as entry text.
    zip.addFile('C:/evil.txt', Buffer.from('pwned'));
    zip.writeZip(zipPath);

    expect(() => safeExtractZip(zipPath, destDir)).toThrow(/resolves outside/);
  });

  it('rejects a zip with too many entries', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 5; i++) {
      zip.addFile(`file-${i}.txt`, Buffer.from('x'));
    }
    zip.writeZip(zipPath);

    expect(() => safeExtractZip(zipPath, destDir, { ...defaultLimits(), maxFileCount: 3 })).toThrow(
      /exceeding the limit/,
    );
  });

  it('rejects a zip exceeding the total uncompressed size cap', () => {
    const zip = new AdmZip();
    zip.addFile('big.txt', Buffer.alloc(1000, 'a'));
    zip.writeZip(zipPath);

    expect(() =>
      safeExtractZip(zipPath, destDir, { ...defaultLimits(), maxUncompressedBytes: 500 }),
    ).toThrow(/maximum uncompressed size/);
  });

  it('rejects a highly compressible entry as a probable zip bomb', () => {
    const zip = new AdmZip();
    // 5MB of a single repeated byte compresses extremely well with deflate,
    // producing a real, organically high compression ratio.
    zip.addFile('bomb.bin', Buffer.alloc(5 * 1024 * 1024, 0));
    zip.writeZip(zipPath);

    expect(() =>
      safeExtractZip(zipPath, destDir, { ...defaultLimits(), maxCompressionRatio: 50 }),
    ).toThrow(/possible zip bomb/);
  });

  it('does not write any files when a later entry fails validation', () => {
    writeFileSync(
      zipPath,
      buildRawZip([
        { name: 'ok.txt', data: Buffer.from('fine') },
        { name: '../escape.txt', data: Buffer.from('pwned') },
      ]),
    );

    expect(() => safeExtractZip(zipPath, destDir)).toThrow();
    expect(existsSync(destDir)).toBe(false);
  });
});

function defaultLimits() {
  return {
    maxUncompressedBytes: 200 * 1024 * 1024,
    maxFileCount: 10_000,
    maxCompressionRatio: 100,
  };
}
