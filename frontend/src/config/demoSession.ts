/** Return whether the presentation-only administrator demo entry is enabled. */
export function isDemoSessionEntryEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_DEMO_SESSION === 'true';
}
