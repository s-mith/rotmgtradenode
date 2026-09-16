// Renders an IGN as plain text. The props mirror what callers pass so
// they don't need to change; `readable` and `style` are accepted and
// ignored (there are no name effects any more).
export default function PlayerName({
  ign,
  className,
}: {
  ign: string;
  style?: unknown;
  className?: string;
  readable?: boolean;
}) {
  return className ? <span className={className}>{ign}</span> : <>{ign}</>;
}
