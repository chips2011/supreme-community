import { useEffect, useRef, useState } from 'react';
import { state, set } from '../store';
import { commitRename } from '../actions';

// Inline rename input for project / thread / tab. Focuses + selects on mount;
// Enter commits, Escape cancels (or enforces a required name), blur commits.
// Mirrors the vanilla `rin` handling in bind().
export function RenameInput({
  value, className, style, ariaLabel,
}: {
  value: string;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); try { el.select(); } catch { /* ignore */ } }
  }, []);

  const cancel = () => {
    if (state.renaming && state.renaming.required) {
      const el = ref.current;
      if (el) {
        el.setCustomValidity('Name this workstream to continue');
        try { el.reportValidity(); el.select(); } catch { /* ignore */ }
      }
    } else {
      state.renaming = null;
      set();
    }
  };

  return (
    <input
      ref={ref}
      className={className}
      style={style}
      aria-label={ariaLabel}
      value={val}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => { setVal(e.target.value); e.target.setCustomValidity(''); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(val, e.currentTarget); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      onBlur={(e) => commitRename(val, e.currentTarget)}
    />
  );
}
