import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../store';
import { Icon } from '../icons';
import { closeShareDialog, removeSharedMember, shareProjectWith } from '../actions';
import { initials } from '../lib/people';

// Paper 19.2: share by email only. The list is who has the project; the owner
// adds by email and can take someone out. There is no link to pass around.
export function ShareDialog() {
  const s = useApp();
  const dialog = s.shareDialog;
  const project = dialog ? s.projects.find((candidate) => candidate.path === dialog.path) : null;
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setEmail(''); setError(''); }, [dialog?.path]);
  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeShareDialog(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);
  if (!dialog || !project) return null;
  const shared = project.shared || null;
  const isOwner = !shared || shared.role === 'owner';
  const meName = s.status?.team?.user?.name || s.userName || 'You';
  const members = shared?.members?.length
    ? shared.members
    : [{ id: 'me', email: s.status?.team?.user?.email || s.user?.email || '', userId: null, role: 'owner' as const, name: meName, accepted: true, me: true, online: true }];

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const clean = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(clean)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    setError('');
    const ok = await shareProjectWith(project.path, clean);
    setBusy(false);
    if (ok) setEmail('');
  };

  return (
    <div className="share-scrim" onClick={closeShareDialog}>
      <section className="share-dialog" role="dialog" aria-modal="true" aria-label={`Share ${project.name}`} onClick={(event) => event.stopPropagation()}>
        <header>
          <b>Share {project.name}</b>
          <button type="button" aria-label="Close" onClick={closeShareDialog}><Icon name="x" size={14} /></button>
        </header>
        {isOwner ? (
          <form onSubmit={send}>
            <input
              type="email"
              autoFocus
              data-share-email
              placeholder="Email address"
              aria-label="Email address"
              value={email}
              disabled={busy}
              onChange={(event) => { setEmail(event.target.value); setError(''); }}
            />
            <button className="primary" type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          </form>
        ) : null}
        {error ? <p className="share-error" role="alert">{error}</p> : null}
        <div className="share-list" aria-label={`Who has ${project.name}`}>
          <small className="share-label">Who has {project.name}</small>
          {members.map((member) => (
            <div className="share-row" key={member.id} data-share-member={member.email}>
              <span className={`av-mini${member.online ? ' on' : ''}`} aria-hidden>{initials(member.name)}</span>
              <span className="share-name">
                {member.me ? `${member.name} (you)` : member.name}
                {member.email && member.email !== member.name ? <s>{member.email}</s> : null}
              </span>
              <em>{member.role === 'owner' ? 'Owner' : member.accepted ? 'Can edit' : 'Invited'}</em>
              {isOwner && member.role !== 'owner' ? (
                <button type="button" aria-label={`Remove ${member.name}`} title="Remove" onClick={() => void removeSharedMember(project.path, member.id)}><Icon name="x" size={12} /></button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
