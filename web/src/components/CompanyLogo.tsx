
export type Company = 'claude' | 'codex' | 'grok' | 'workbench';

export function SupremeMark({ size = 24 }: { size?: number }) {
  return (
    <span className="supreme-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="m6.5 14.5 5.5-6 5.5 6" />
        <path d="M8.25 17h7.5" />
      </svg>
    </span>
  );
}

// Community builds use text labels instead of third-party provider artwork.
export function CompanyLogo({ company, size = 22 }: { company: Company; size?: number }) {
  if (company === 'claude') {
    return <span className="company-logo" style={{ fontSize: size * 0.55, fontWeight: 600 }} aria-hidden="true">Cl</span>;
  }
  if (company === 'codex') {
    return <span className="company-logo" style={{ fontSize: size * 0.55, fontWeight: 600 }} aria-hidden="true">Co</span>;
  }
  if (company === 'grok') {
    return (
      <svg className="company-logo grok-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5 19 19M19 5 5 19" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span className="workbench-logo" style={{ width: size, height: size }} aria-hidden="true">
      <span />
    </span>
  );
}
