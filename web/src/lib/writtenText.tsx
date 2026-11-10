import { Fragment, useState, type ReactNode, type CSSProperties, useMemo } from 'react';
import { normalizeWrittenOutput, writtenImage } from '../../../lib/written-output.mjs';

// Faithful port of the vanilla structured-answer renderer. Parses an assistant
// message into blocks (paragraphs, headings, lists, dividers, fenced drafts) and renders the
// "written" layout: an intro rail, numbered sections, lists, sources, and a
// ramped-up payoff. Logic mirrors public/app.js 1:1.

interface ListItem { marker: string; depth: number; text: string }
type TableAlign = 'left' | 'center' | 'right';
type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'divider' }
  | { type: 'code'; language: string; text: string }
  | { type: 'image'; label: string; target: string }
  // A markdown blockquote (lines starting with >), how models often hand
  // over an email or a message to send. Line breaks are kept.
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; headers: string[]; align: TableAlign[]; rows: string[][] };

// Older provider streams sometimes omitted the boundary between two separate
// assistant text blocks, leaving saved prose like `finished.Next step`. Repair
// only that unmistakable no-whitespace case for display. Fenced and inline code
// are left byte-for-byte alone.
export function repairRunOnWriting(value: string): string {
  let inFence = false;
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`\n]*`)/g)
        .map((part, index) => index % 2
          ? part
          : part.replace(/([a-z0-9)\]”’"'])([.!?])(?=(?:[A-Z][a-z]|I(?:['’]|\s)))/g, '$1$2\n\n'))
        .join('');
    })
    .join('\n');
}

function tableCells(value: string): string[] {
  const text = value.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  let inCode = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === '`') {
      current += char;
      inCode = !inCode;
    } else if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/\\\|/g, '|'));
}

function tableDivider(value: string): { align: TableAlign[] } | null {
  if (!value.includes('|')) return null;
  const cells = tableCells(value);
  if (!cells.length || !cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))) return null;
  return {
    align: cells.map((cell) => {
      const compact = cell.replace(/\s/g, '');
      if (compact.startsWith(':') && compact.endsWith(':')) return 'center';
      if (compact.endsWith(':')) return 'right';
      return 'left';
    }),
  };
}

export function parseWrittenBlocks(value: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { type: 'list'; ordered: boolean; items: ListItem[] } | null = null;
  let fence: { language: string; lines: string[] } | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list || !list.items.length) return;
    blocks.push(list);
    list = null;
  };

  const lines = repairRunOnWriting(value).split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    if (fence) {
      if (/^\s*```\s*$/.test(rawLine)) {
        blocks.push({ type: 'code', language: fence.language, text: fence.lines.join('\n') });
        fence = null;
      } else {
        fence.lines.push(rawLine);
      }
      continue;
    }
    const fenceStart = rawLine.match(/^\s*```([^\s`]*)\s*$/);
    if (fenceStart) {
      flushParagraph();
      flushList();
      fence = { language: (fenceStart[1] || '').toLowerCase(), lines: [] };
      continue;
    }
    const line = rawLine.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const image = writtenImage(line);
    if (image) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'image', ...image });
      continue;
    }
    const divider = lineIndex + 1 < lines.length ? tableDivider(lines[lineIndex + 1]) : null;
    if (divider && line.includes('|')) {
      flushParagraph();
      flushList();
      const headers = tableCells(line).slice(0, 12);
      const rows: string[][] = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].includes('|') && lines[lineIndex].trim()) {
        const row = tableCells(lines[lineIndex]).slice(0, headers.length);
        while (row.length < headers.length) row.push('');
        rows.push(row);
        lineIndex += 1;
        if (rows.length >= 100) {
          while (lineIndex < lines.length && lines[lineIndex].includes('|') && lines[lineIndex].trim()) lineIndex += 1;
          break;
        }
      }
      lineIndex -= 1;
      blocks.push({
        type: 'table',
        headers,
        align: headers.map((_, index) => divider.align[index] || 'left'),
        rows,
      });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'divider' });
      continue;
    }

    // A blockquote keeps its lines: the markers go, blank quoted lines stay
    // as paragraph breaks, and the block ends at the first unquoted line.
    if (/^\s*>/.test(rawLine)) {
      flushParagraph();
      flushList();
      const quoted: string[] = [];
      while (lineIndex < lines.length && /^\s*>/.test(lines[lineIndex])) {
        quoted.push(lines[lineIndex].replace(/^\s*>\s?/, '').replace(/\s+$/, ''));
        lineIndex += 1;
      }
      lineIndex -= 1;
      const text = quoted.join('\n').replace(/^\n+|\n+$/g, '');
      if (text.trim()) blocks.push({ type: 'quote', text });
      continue;
    }

    const bullet = rawLine.match(/^(\s*)([-*•]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      const ordered = /^\d/.test(bullet[2]);
      if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, items: [] }; }
      list.items.push({
        marker: ordered ? bullet[2] : '•',
        depth: Math.min(3, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)),
        text: bullet[3].trim(),
      });
      continue;
    }

    flushList();
    const markdownHeading = line.match(/^#{1,4}\s+(.+)$/);
    const colonHeading = line.endsWith(':') && line.length <= 100 && line.split(/\s+/).length <= 14;
    if (markdownHeading || colonHeading || /^sources?$/i.test(line)) {
      flushParagraph();
      const title = (markdownHeading ? markdownHeading[1] : line).replace(/:\s*$/, '').trim();
      blocks.push({ type: 'heading', text: title });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  const trailingFence = fence as { language: string; lines: string[] } | null;
  if (trailingFence) blocks.push({ type: 'code', language: trailingFence.language, text: trailingFence.lines.join('\n') });
  return blocks;
}

// What goes on the clipboard: the text as a person would paste it into an
// email, with inline markdown markers gone and links kept as plain URLs.
function plainForCopy(value: string): string {
  return String(value || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => (label.trim() === url.trim() ? url : `${label} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// Every quote and every fenced draft gets one. No guessing what is an email:
// the button is there whenever the model set text apart to be used as is.
function CopyButton({ text, what }: { text: string; what: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={`written-copy ${state}`}
      aria-label={`Copy ${what}`}
      title={`Copy ${what}`}
      onClick={async () => {
        const ok = await writeClipboard(text);
        setState(ok ? 'copied' : 'failed');
        window.setTimeout(() => setState('idle'), 1_400);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy'}
    </button>
  );
}

// Strip **/__ markers, then wrap numbers in <b class="written-number">.
function renderWrittenPlain(value: string, keyBase: string): ReactNode[] {
  const clean = String(value || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1');
  const re = /((?:[$€£])?\b\d[\d,.]*(?:[–-]\d[\d,.]*)*\b(?:%|[x×]|\/day)?)/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(clean))) {
    if (match.index > cursor) out.push(clean.slice(cursor, match.index));
    out.push(<b key={`${keyBase}n${i++}`} className="written-number">{match[1]}</b>);
    cursor = re.lastIndex;
  }
  if (cursor < clean.length) out.push(clean.slice(cursor));
  return out;
}

// Inline: [label](url) links + `code` spans, plain otherwise.
export function renderWrittenInline(value: string, keyBase = 'i'): ReactNode[] {
  const text = String(value || '');
  const token = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"’”])/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = token.exec(text))) {
    out.push(<Fragment key={`${keyBase}p${i}`}>{renderWrittenPlain(text.slice(cursor, match.index), `${keyBase}p${i}`)}</Fragment>);
    if (match[1]) {
      out.push(
        <a key={`${keyBase}l${i}`} className="written-link" href={match[2]} target="_blank" rel="noopener noreferrer">
          {renderWrittenPlain(match[1], `${keyBase}l${i}`)} ↗
        </a>,
      );
    } else if (match[3]) {
      out.push(<code key={`${keyBase}c${i}`}>{match[3]}</code>);
    } else {
      // Bare URLs become links and may wrap; as raw text a long doc URL is one
      // unbreakable word that pushes past the message bubble.
      out.push(
        <a key={`${keyBase}b${i}`} className="written-link written-bare-link" href={match[4]} target="_blank" rel="noopener noreferrer">
          {match[4]}
        </a>,
      );
    }
    cursor = token.lastIndex;
    i += 1;
  }
  out.push(<Fragment key={`${keyBase}pz`}>{renderWrittenPlain(text.slice(cursor), `${keyBase}pz`)}</Fragment>);
  return out;
}

function writtenSourceLinks(value: string): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(value || '')))) {
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    links.push({ label: match[1], url: match[2] });
  }
  return links;
}

function renderWrittenSources(value: string, key: string): ReactNode | null {
  const links = writtenSourceLinks(value);
  if (!links.length) return null;
  return (
    <div key={key} className="written-sources">
      <span>Sources</span>
      {links.map((link, i) => (
        <a key={i} href={link.url} target="_blank" rel="noopener noreferrer">
          {renderWrittenPlain(link.label, `${key}s${i}`)} ↗
        </a>
      ))}
    </div>
  );
}

function looksLikeAnswerLead(value: string): boolean {
  return /^(?:yes\b|no\b|done\b|complete\b|here(?:['’]s|\s+(?:are|is))\b|i['’]m\s+(?:fully\s+)?ramped up\b|the\s+(?:answer|result|draft|recommendation)\b|(?:final|recommended|best)\b)/i.test(String(value || '').trim());
}

export function WorkNotes({ notes, live = false }: { notes?: string[]; live?: boolean }) {
  const clean = (notes || []).map((note) => String(note || '').trim()).filter(Boolean);
  if (!clean.length) return null;
  if (live) {
    const visible = clean.slice(-4);
    return (
      <div className="written-intro live-work-notes" aria-label="Working notes" aria-live="polite">
        {visible.map((note, index) => <div key={`${clean.length - visible.length + index}:${note}`}>{renderWrittenInline(note, `livework${index}`)}</div>)}
      </div>
    );
  }
  return (
    <details className="written-intro-details explicit-work-notes">
      <summary><span>Work notes</span><i>· {clean.length}</i></summary>
      <div className="written-intro">
        {clean.map((note, index) => <div key={index}>{renderWrittenInline(note, `work${index}`)}</div>)}
      </div>
    </details>
  );
}

// Use the same rules as provider cleanup, including old saved directives.
export function normalizeCodexCitations(value: string): string {
  return normalizeWrittenOutput(value);
}

interface OutputImage { target: string; name: string; url: string }

function WrittenImage({ label, target, images }: { label: string; target: string; images?: OutputImage[] }) {
  const image = images?.find((candidate) => candidate.target === target);
  // Only URLs supplied by the task API can load local images. Remote images
  // are links, not automatic tracking requests when a transcript is opened.
  const src = image?.url && /^\/api\/tasks\/[^/]+\/tabs\/[^/]+\/output-images\/[a-f0-9]{64}$/.test(image.url) ? image.url : undefined;
  const [failedSource, setFailedSource] = useState<string>();
  const name = label || image?.name || target.split('/').at(-1) || 'Image';
  if (src && failedSource !== src) {
    return (
      <figure className="written-image ph-no-capture">
        <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name}`}>
          <img src={src} alt={name} loading="lazy" onError={() => setFailedSource(src)} />
        </a>
      </figure>
    );
  }
  if (/^https?:\/\//i.test(target)) return <div className="written-paragraph">{renderWrittenInline(`[${name}](${target})`)}</div>;
  return <div className="written-image-unavailable"><span>{name}</span><small>Unavailable on this computer</small></div>;
}

// Section 31.1: a reply that hands over several drafts, each under its own
// "N. Name" line, can have each one ticked or skipped before the one Send.
// Only that shape counts; anything else keeps the single Confirm.
export interface DraftPick { block: number; n: number; name: string }
export function draftPicks(value: string): DraftPick[] {
  const blocks = parseWrittenBlocks(normalizeCodexCitations(value));
  const picks: DraftPick[] = [];
  blocks.forEach((block, index) => {
    const before = blocks[index - 1];
    if (block.type !== 'code' || !before || before.type !== 'list' || !before.ordered) return;
    if (block.language && !['text', 'txt', 'md', 'markdown'].includes(block.language)) return;
    const item = before.items[before.items.length - 1];
    const n = Number.parseInt(item?.marker || '', 10);
    const name = String(item?.text || '').replace(/[*_`]/g, '').trim();
    if (Number.isFinite(n) && name) picks.push({ block: index, n, name });
  });
  return picks.length >= 2 ? picks : [];
}
export interface DraftPicking { skipped: ReadonlySet<number>; toggle: (block: number) => void; picks: DraftPick[] }

export function WrittenText({ value, inferWorkNotes = true, picking, images }: { value: string; inferWorkNotes?: boolean; picking?: DraftPicking; images?: OutputImage[] }) {
  // Parsing is the expensive half of rendering a message; a set() storm from
  // live shared runs must not re-parse unchanged history (2026-08-31, the
  // renderer froze long enough to queue clicks).
  const blocks = useMemo(() => parseWrittenBlocks(normalizeCodexCitations(value)), [value]);
  if (!blocks.length) return <div className="msg written" />;

  const structuralIndex = inferWorkNotes
    ? blocks.findIndex((b) => b.type === 'heading' || b.type === 'list' || b.type === 'divider' || b.type === 'table')
    : -1;
  const payoffIndex = inferWorkNotes
    ? blocks.findIndex((b) => b.type === 'paragraph' && /^i['’]m\s+(?:fully\s+)?ramped up\b/i.test(b.text))
    : -1;
  const starts = [structuralIndex, payoffIndex].filter((index) => index >= 0);
  const firstAnswerBlock = starts.length ? Math.min(...starts) : -1;

  // A paragraph immediately before a list/table is normally the answer lead
  // ("Yes—across all 733…", "Done: …", "Here are the three…"). Keep that
  // sentence attached to the deliverable instead of sweeping it into the
  // muted work-notes rail merely because the next block happens to be a list.
  const priorAnswerBlock = firstAnswerBlock > 0 ? blocks[firstAnswerBlock - 1] : null;
  const hasAnswerLead = firstAnswerBlock > 0
    && firstAnswerBlock === structuralIndex
    && priorAnswerBlock?.type === 'paragraph'
    && looksLikeAnswerLead(priorAnswerBlock.text);
  const introEnd = firstAnswerBlock < 0
    ? -1
    : hasAnswerLead
      ? firstAnswerBlock - 1
      : firstAnswerBlock;
  const hasIntroRail = introEnd >= 2 && blocks.slice(0, introEnd).every((b) => b.type === 'paragraph');

  const nodes: ReactNode[] = [];
  let start = 0;
  let headingNumber = 0;

  if (hasIntroRail) {
    const introBlocks = blocks.slice(0, introEnd);
    const introRail = (
      <div className="written-intro">
        {introBlocks.map((b, i) => (
          <div key={i}>{renderWrittenInline(b.type === 'paragraph' ? b.text : '', `intro${i}`)}</div>
        ))}
      </div>
    );
    nodes.push(introBlocks.length > 4 ? (
      <details key="intro" className="written-intro-details">
        <summary><span>Work notes</span><i>· {introBlocks.length}</i></summary>
        {introRail}
      </details>
    ) : <Fragment key="intro">{introRail}</Fragment>);
    start = introEnd;
  }

  for (let index = start; index < blocks.length; index += 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    const key = `b${index}`;
    if (block.type === 'image') {
      nodes.push(<WrittenImage key={`${key}:${block.target}`} label={block.label} target={block.target} images={images} />);
      continue;
    }
    if (block.type === 'heading' && /^sources?$/i.test(block.text)) {
      const sourceText = next && next.type === 'list' ? next.items.map((item) => item.text).join('\n') : '';
      const sources = renderWrittenSources(sourceText, key);
      if (sources) { nodes.push(sources); index += 1; }
      else nodes.push(<div key={key} className="written-section source"><span>{block.text}</span><i /></div>);
      continue;
    }
    if (block.type === 'heading') {
      headingNumber += 1;
      nodes.push(
        <div key={key} className="written-section">
          <small>{String(headingNumber).padStart(2, '0')}</small>
          <span>{renderWrittenInline(block.text, key)}</span>
          <i />
        </div>,
      );
      continue;
    }
    if (block.type === 'list') {
      nodes.push(
        <div key={key} className="written-list">
          {block.items.map((item, i) => (
            <div key={i} className="written-item" style={{ '--depth': item.depth } as CSSProperties}>
              <span className="written-marker">{item.marker}</span>
              <span>{renderWrittenInline(item.text, `${key}i${i}`)}</span>
            </div>
          ))}
        </div>,
      );
      continue;
    }
    if (block.type === 'divider') {
      nodes.push(<div key={key} className="written-divider" />);
      continue;
    }
    if (block.type === 'quote') {
      const paragraphs = block.text.split(/\n{2,}/).map((paragraph) => paragraph.split('\n'));
      nodes.push(
        <blockquote key={key} className="written-quote">
          <CopyButton text={plainForCopy(block.text)} what="quoted text" />
          {paragraphs.map((lines, paragraphIndex) => (
            <p key={paragraphIndex}>
              {lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex ? <br /> : null}
                  {renderWrittenInline(line, `${key}-q${paragraphIndex}-${lineIndex}`)}
                </Fragment>
              ))}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (block.type === 'code') {
      const plain = !block.language || ['text', 'txt', 'md', 'markdown'].includes(block.language);
      const pick = picking?.picks.find((row) => row.block === index);
      const skipped = !!pick && picking!.skipped.has(index);
      nodes.push(
        <div key={key} className={`written-code ${plain ? 'plain' : ''}${pick ? ' pickable' : ''}${skipped ? ' skipped' : ''}`}>
          <span>
            {pick ? (
              <button
                type="button"
                role="checkbox"
                className="draft-pick"
                aria-checked={!skipped}
                aria-label={`${pick.n}. ${pick.name}`}
                onClick={() => picking!.toggle(index)}
              >{skipped ? null : <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.6-5" /></svg>}</button>
            ) : null}
            {plain ? 'Draft' : block.language}
          </span>
          <CopyButton text={block.text} what={plain ? 'draft' : block.language} />
          <pre>{block.text}</pre>
        </div>,
      );
      continue;
    }
    if (block.type === 'table') {
      nodes.push(
        <div key={key} className="written-table-wrap" role="region" aria-label="Response table" tabIndex={0}>
          <table className="written-table">
            <thead>
              <tr>{block.headers.map((header, cellIndex) => (
                <th key={cellIndex} style={{ textAlign: block.align[cellIndex] }}>{renderWrittenInline(header, `${key}h${cellIndex}`)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: block.align[cellIndex] }}>{renderWrittenInline(cell, `${key}r${rowIndex}c${cellIndex}`)}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // paragraph
    const inlineSources = /^sources?\s*:/i.test(block.text) ? renderWrittenSources(block.text, key) : null;
    if (inlineSources) { nodes.push(inlineSources); continue; }
    if (/^i['’]m\s+(?:fully\s+)?ramped up\b/i.test(block.text)) {
      nodes.push(
        <div key={key} className="written-payoff"><span>✓</span><div>{renderWrittenInline(block.text, key)}</div></div>,
      );
      continue;
    }
    const last = index === blocks.length - 1;
    const endnote = last && /^(?:i (?:haven['’]t|didn['’]t|did not)|no (?:drafts|messages|changes)\b|nothing (?:was|has been)\b)/i.test(block.text);
    nodes.push(
      <div key={key} className={`written-paragraph ${endnote ? 'written-endnote' : ''}`}>{renderWrittenInline(block.text, key)}</div>,
    );
  }

  return <div className="msg written">{nodes}</div>;
}
