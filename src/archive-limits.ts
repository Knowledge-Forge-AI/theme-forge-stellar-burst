export const ARCHIVE_LIMITS = {
  totalEntries: 1_024,
  selectedSvgEntries: 128,
  selectedEntryBytes: 8 * 1024 * 1024,
  selectedAggregateBytes: 32 * 1024 * 1024,
  expansionRatio: 100,
  centralDirectoryBytes: 64 * 1024 * 1024,
  archiveFileBytes: 128 * 1024 * 1024,
} as const;

export function mutationSvgCountExceedsLimit(count: number): boolean {
  return count > ARCHIVE_LIMITS.selectedSvgEntries;
}

export function mutationAggregateBytesExceedsLimit(bytes: number): boolean {
  return bytes > ARCHIVE_LIMITS.selectedAggregateBytes;
}
