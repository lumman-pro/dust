let lockCount = 0;

export function isNavigationLocked(): boolean {
  return lockCount > 0;
}
