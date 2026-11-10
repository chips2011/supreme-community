import { Icon } from '../icons';
import type { ImageAttachment, PendingImageAttachment } from '../types';

type PreviewAttachment = ImageAttachment | PendingImageAttachment;

function sourceFor(attachment: PreviewAttachment): string | undefined {
  return 'dataUrl' in attachment ? attachment.dataUrl : attachment.url;
}

export function ImageAttachments({
  attachments,
  pending = false,
  compact = false,
  onRemove,
}: {
  attachments?: PreviewAttachment[];
  pending?: boolean;
  compact?: boolean;
  onRemove?: (attachment: PreviewAttachment) => void;
}) {
  if (!attachments?.length) return null;
  return (
    <div className={`image-attachments ph-no-capture${pending ? ' pending' : ''}${compact ? ' compact' : ''}`}>
      {attachments.map((attachment) => {
        if (attachment.kind === 'file') {
          const src = sourceFor(attachment);
          const fileChip = (
            <span className="file-chip">
              <Icon name="fileText" size={15} />
              <span className="file-name">{attachment.name || 'Attachment'}</span>
            </span>
          );
          return (
            <figure key={attachment.id} className="file-attachment" title={attachment.name}>
              {src && !pending ? (
                <a href={src} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name || 'attached file'}`}>
                  {fileChip}
                </a>
              ) : fileChip}
              {onRemove ? (
                <button type="button" aria-label={`Remove ${attachment.name || 'file'}`} onClick={() => onRemove(attachment)}>
                  <Icon name="x" size={11} />
                </button>
              ) : null}
            </figure>
          );
        }
        const src = sourceFor(attachment);
        const visual = src ? (
          <img src={src} alt={attachment.name || 'Attached image'} />
        ) : (
          <span className="image-unavailable"><Icon name="paperclip" size={17} />Unavailable on this computer</span>
        );
        return (
          <figure key={attachment.id} title={attachment.name}>
            {src && !pending ? (
              <a href={src} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name || 'attached image'}`}>
                {visual}
              </a>
            ) : visual}
            {onRemove ? (
              <button type="button" aria-label={`Remove ${attachment.name || 'image'}`} onClick={() => onRemove(attachment)}>
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </figure>
        );
      })}
    </div>
  );
}
