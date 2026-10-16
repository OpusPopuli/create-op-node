import { statfs } from 'node:fs/promises';

/** Free and total bytes on the filesystem holding a path. */
export interface DiskSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/**
 * Free space on the filesystem holding `path`.
 *
 * `statfs` rather than shelling out to `df`: no parsing of a locale- and
 * platform-dependent text table, and no child process in a CLI that already
 * knows how to ask the kernel.
 *
 * Uses `bavail` (blocks available to an unprivileged user), not `bfree`.
 * They differ by the reserved superuser margin — commonly 5% of the
 * filesystem — and the number an operator can actually fill is `bavail`.
 * Reporting `bfree` would promise headroom that writes cannot use.
 */
export async function checkDiskSpace(path: string): Promise<DiskSpace> {
  const stats = await statfs(path);
  return {
    freeBytes: Number(stats.bsize) * Number(stats.bavail),
    totalBytes: Number(stats.bsize) * Number(stats.blocks),
  };
}

/** Bytes as a human-readable GB string, one decimal. */
export function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
