/** How long an incident lasted, like "12 min", "3.5 h" or "4 days". */
export function duration(from: string, to: string) {
  const minutes = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${Math.round(hours / 24)} days`;
}
