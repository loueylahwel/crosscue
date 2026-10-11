/**
 * Per-browser conveniences (last marker sizes, field of view, relay address). Storage can be missing
 * or blocked, so every access falls back to the default instead of throwing.
 */
const PREFIX = 'crosscue.';

export function loadSetting<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just will not persist */
  }
}
