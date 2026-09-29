/** Input level as a meter. The bar scales with the level; reduced motion only removes the easing. */
export function InPersonLevel({ level, label, paused = false }: { level: number; label: string; paused?: boolean }) {
  const value = Math.round(Math.max(0, Math.min(1, level)) * 100);
  return <div className="ip-level" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={paused ? "Paused" : value < 4 ? "Silent" : `${value}%`} data-paused={paused || undefined}>
    <span className="ip-level-fill" style={{ transform: `scaleX(${value / 100})` }} />
  </div>;
}
