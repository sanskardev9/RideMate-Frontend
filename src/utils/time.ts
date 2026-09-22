/** A position older than this is no longer a fair picture of where a rider is. */
export const STALE_AFTER_MS = 45000;

export const ageMs = (iso: string) => Date.now() - new Date(iso).getTime();

export const isStale = (iso: string) => ageMs(iso) > STALE_AFTER_MS;

/** Short, glanceable age: "now", "40s", "6m", "2h". */
export function shortAge(iso: string): string {
  const seconds = Math.max(0, Math.round(ageMs(iso) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
