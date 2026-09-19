/** Display the persisted second-level precision without floating-point minute tails. */
export function formatTrackedDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes * 60));
  const hours = Math.floor(total / 3600), mins = Math.floor(total % 3600 / 60), seconds = total % 60;
  return `${hours ? `${hours}h ` : ''}${mins}m${seconds ? ` ${seconds}s` : ''}`;
}
