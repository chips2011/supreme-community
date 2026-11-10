import { EFFORT_NAMES } from '../constants';

// The prototype's effort indicator: ascending signal-strength bars, filled up to
// the current level.
export function EffortBars({ value }: { value: string }) {
  const idx = EFFORT_NAMES.indexOf(value);
  return (
    <b>
      {[4, 6, 8, 10, 12].map((h, i) => (
        <s key={i} style={{ height: h }} className={i <= idx ? 'on' : ''} />
      ))}
    </b>
  );
}
