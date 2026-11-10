import { useApp } from '../store';

export function Toast() {
  const s = useApp();
  if (!s.toast) return null;
  return (
    <div
      style={{
        position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        background: 'var(--ink)', color: '#fff', padding: '9px 14px', borderRadius: 8,
        font: '500 11px/1 var(--f)', zIndex: 40,
      }}
    >
      {s.toast}
    </div>
  );
}
