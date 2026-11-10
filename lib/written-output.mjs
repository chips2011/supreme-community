// Shared by provider cleanup and the transcript renderer. Local file citations
// remain filenames, but web documents and Markdown images keep their meaning.
const DIRECTIVE = /:codex-[a-z-]+\{([^}]*)\}/g;
const LOCAL_LINK = /(?<!!)\[([^\]\n]+)\]\(\s*(?:<((?:file:\/\/|~\/|\/)[^>\n]+)>|((?:file:\/\/|~\/|\/)[^)\n]+?))\s*\)/g;
const IMAGE_SOURCE = String.raw`!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s*\)`;

export function outsideWrittenCode(value, transform) {
  return String(value || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, index) => index % 2 ? part : transform(part)).join('');
}

export function writtenImage(value) {
  const match = new RegExp(`^${IMAGE_SOURCE}$`).exec(String(value || '').trim());
  return match ? { label: match[1], target: match[2] || match[3] } : null;
}

export function localWrittenImages(value) {
  if (!String(value || '').includes('![')) return [];
  const images = [];
  const seen = new Set();
  outsideWrittenCode(value, (part) => {
    for (const match of part.matchAll(new RegExp(IMAGE_SOURCE, 'g'))) {
      if (images.length >= 12) break;
      const target = match[2] || match[3];
      if (!/^(?:\/(?!\/)|~\/|file:\/\/\/)/.test(target) || seen.has(target)) continue;
      seen.add(target);
      images.push({ label: match[1], target });
    }
    return part;
  });
  return images.slice(0, 12);
}

function webCitation(target) {
  if (!/^https?:\/\//i.test(target) || /[\u0000-\u0020\u007f]/.test(target)) return null;
  try {
    const url = new URL(target);
    if (url.username || url.password) return null;
    let label = url.hostname;
    if (url.hostname === 'docs.google.com') {
      label = url.pathname.startsWith('/spreadsheets/') ? 'Google Sheets'
        : url.pathname.startsWith('/document/') ? 'Google Docs'
          : url.pathname.startsWith('/presentation/') ? 'Google Slides' : 'Google Drive';
    } else if (url.hostname === 'drive.google.com') label = 'Google Drive';
    // Parentheses are legal in URLs, but must not terminate Markdown links.
    return `[${label}](${url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
  } catch { return null; }
}

export function normalizeWrittenOutput(value) {
  return outsideWrittenCode(value, (part) => part
    .replace(DIRECTIVE, (_all, body) => {
      const target = /path="([^"]*)"/.exec(body)?.[1] || '';
      const web = webCitation(target);
      if (web) return web;
      const name = target.split('/').filter(Boolean).at(-1) || '';
      return name ? `\`${name.replace(/`/g, '')}\`` : '';
    })
    .replace(LOCAL_LINK, (_all, label, angled, plain) => {
      const name = String(angled || plain).trim().split('/').filter(Boolean).at(-1) || '';
      const text = label.trim();
      if (!name) return text;
      const filename = `\`${name.replace(/`/g, '')}\``;
      return text === name ? filename : `${text} ${filename}`;
    }));
}
