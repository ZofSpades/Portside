import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

export interface ZipExtractionLimits {
  maxUncompressedBytes: number;
  maxFileCount: number;
  /** Per-entry uncompressed/compressed ratio above which extraction is refused (zip-bomb guard). */
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipExtractionLimits = {
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxFileCount: 10_000,
  maxCompressionRatio: 100,
};

/**
 * Extracts a zip file after validating every entry against zip-slip (paths
 * escaping destDir), a total uncompressed size cap, a file-count cap, and a
 * per-entry compression-ratio cap (zip-bomb guard). Throws before writing
 * anything if any entry fails a check.
 */
export function safeExtractZip(
  zipPath: string,
  destDir: string,
  limits: ZipExtractionLimits = DEFAULT_ZIP_LIMITS,
): void {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > limits.maxFileCount) {
    throw new Error(
      `Zip contains ${entries.length} entries, exceeding the limit of ${limits.maxFileCount}`,
    );
  }

  const resolvedDest = path.resolve(destDir);
  let totalUncompressed = 0;

  for (const entry of entries) {
    const targetPath = path.resolve(destDir, entry.entryName);
    if (targetPath !== resolvedDest && !targetPath.startsWith(resolvedDest + path.sep)) {
      throw new Error(`Zip entry "${entry.entryName}" resolves outside the extraction directory`);
    }

    const uncompressedSize = entry.header.size;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      throw new Error(
        `Zip exceeds the maximum uncompressed size of ${limits.maxUncompressedBytes} bytes`,
      );
    }

    const compressedSize = entry.header.compressedSize;
    if (compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > limits.maxCompressionRatio) {
        throw new Error(
          `Zip entry "${entry.entryName}" has a suspicious compression ratio ` +
            `(${ratio.toFixed(1)}x) — possible zip bomb`,
        );
      }
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  zip.extractAllTo(destDir, true);
}
