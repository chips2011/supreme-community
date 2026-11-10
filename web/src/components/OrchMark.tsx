// Section 27: the orchestrator's mark, one hub and three spokes, the tab
// type's identity on the tab chip, the rail row, the type menu, the hub and
// the map head (Paper board 27.1, drawn at 12, 13 and 16).
export function OrchMark({ size = 13, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`orch-mark${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M7 7 L7 2.4 M7 7 L3 10.6 M7 7 L11 10.6" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="7" cy="7" r="2.6" fill="currentColor" />
      <circle cx="7" cy="2" r="1.5" className="orch-mark-hollow" stroke="currentColor" strokeWidth="1" />
      <circle cx="2.4" cy="11.4" r="1.5" className="orch-mark-hollow" stroke="currentColor" strokeWidth="1" />
      <circle cx="11.6" cy="11.4" r="1.5" className="orch-mark-hollow" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
