export function hasInAppHistory() {
  if (typeof window === 'undefined') return false;

  return typeof window.history.state?.__TSR_index === 'number' && window.history.state.__TSR_index > 0;
}
