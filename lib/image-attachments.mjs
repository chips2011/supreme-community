import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
// Any non-image file the user drags in. Files are copied into the run's worktree
// (see materializeFilesIntoWorktree) so a cwd-sandboxed CLI like Codex can read
// them from disk; larger and more numerous than pasted screenshots.
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_TOTAL_BYTES = 50 * 1024 * 1024;
const WORKTREE_SUBDIR = 'supreme-attachments';

const IMAGE_TYPES = {
  'image/png': { extension: '.png', matches: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { extension: '.jpg', matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  'image/webp': { extension: '.webp', matches: (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
};

function safeUuid(value) {
  const id = String(value || '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function attachmentKind(attachment) {
  return attachment?.kind === 'file' ? 'file' : 'image';
}

function cleanDisplayName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '-')
    .trim()
    .slice(0, 120);
}

function imageDisplayName(value, mimeType, index) {
  const clean = cleanDisplayName(value);
  if (clean) return clean;
  return `Screenshot ${index + 1}${IMAGE_TYPES[mimeType].extension}`;
}

function fileDisplayName(value, extension, index) {
  const clean = cleanDisplayName(value);
  if (clean) return clean;
  return `Attachment ${index + 1}${extension || ''}`;
}

function safeMimeType(value) {
  const raw = String(value || '').toLowerCase().replace(/[^a-z0-9.+/_-]/g, '').slice(0, 120);
  return raw || 'application/octet-stream';
}

// Extension for the on-disk stored file, derived from the ORIGINAL filename.
// Only used to name `<id><extension>` under DATA_DIR; kept short + charset-safe.
function safeFileExtension(name) {
  const raw = path.extname(String(name || '')).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9.]/g, '').replace(/^\.+/, '').replace(/\.+/g, '.');
  if (!cleaned) return '.bin';
  return `.${cleaned}`.slice(0, 12);
}

// Validate an extension that came back off a persisted record before it is
// interpolated into a filesystem path.
function safeStoredExtension(value) {
  const ext = String(value || '').toLowerCase();
  if (!/^\.[a-z0-9][a-z0-9.]{0,10}$/.test(ext) || ext.includes('..')) return null;
  return ext;
}

// data:<mediatype>;base64,<payload> — mediatype (and its params) may be empty;
// only base64 payloads are accepted. Returns the decoded Buffer or null.
function decodeBase64DataUrl(dataUrl) {
  const match = /^data:[^,]*;base64,([a-z0-9+/]*={0,2})$/i.exec(String(dataUrl || ''));
  if (!match || !match[1]) return null;
  const bytes = Buffer.from(match[1], 'base64');
  return bytes.length ? bytes : null;
}

function imageDirectory(taskId, tabId) {
  const safeTask = safeUuid(taskId);
  const safeTab = safeUuid(tabId);
  if (!safeTask || !safeTab) throw new Error('invalid attachment destination');
  return path.join(ATTACHMENTS_DIR, safeTask, safeTab);
}

export function imageAttachmentPath(taskId, tabId, attachment) {
  const id = safeUuid(attachment?.id);
  if (!id) return null;
  if (attachmentKind(attachment) === 'file') {
    const extension = safeStoredExtension(attachment?.extension);
    if (!extension) return null;
    return path.join(imageDirectory(taskId, tabId), `${id}${extension}`);
  }
  const type = IMAGE_TYPES[String(attachment?.mimeType || '').toLowerCase()];
  if (!type) return null;
  return path.join(imageDirectory(taskId, tabId), `${id}${type.extension}`);
}

export function imageAttachmentRecord(attachment) {
  const id = safeUuid(attachment?.id);
  if (!id) return null;
  const size = Number(attachment?.size);
  const promptIndex = Math.max(0, Math.min(99, Math.floor(Number(attachment?.promptIndex) || 0)));
  if (attachmentKind(attachment) === 'file') {
    const extension = safeStoredExtension(attachment?.extension);
    if (!extension || !Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) return null;
    return {
      id,
      kind: 'file',
      name: fileDisplayName(attachment?.name, extension, promptIndex),
      mimeType: safeMimeType(attachment?.mimeType),
      size,
      extension,
      promptIndex,
    };
  }
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  if (!IMAGE_TYPES[mimeType] || !Number.isFinite(size) || size <= 0 || size > MAX_IMAGE_BYTES) return null;
  return {
    id,
    name: imageDisplayName(attachment?.name, mimeType, promptIndex),
    mimeType,
    size,
    promptIndex,
  };
}

export function publicImageAttachments(attachments, taskId, tabId) {
  return (Array.isArray(attachments) ? attachments : []).flatMap((attachment) => {
    const record = imageAttachmentRecord(attachment);
    if (!record) return [];
    const filePath = imageAttachmentPath(taskId, tabId, record);
    const available = !!filePath && fs.existsSync(filePath);
    return [{
      ...record,
      available,
      ...(available ? { url: `/api/tasks/${taskId}/tabs/${tabId}/attachments/${record.id}` } : {}),
    }];
  });
}

export function saveIncomingImageAttachments(value, { taskId, tabId } = {}) {
  const incomingList = Array.isArray(value) ? value : [];
  if (!incomingList.length) return [];
  const imageCount = incomingList.filter((item) => attachmentKind(item) !== 'file').length;
  const fileCount = incomingList.length - imageCount;
  if (imageCount > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images at a time.`);
  if (fileCount > MAX_FILES) throw new Error(`Attach up to ${MAX_FILES} files at a time.`);

  const directory = imageDirectory(taskId, tabId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}

  let imageBytes = 0;
  let fileBytes = 0;
  const written = [];
  try {
    for (let index = 0; index < incomingList.length; index += 1) {
      const incoming = incomingList[index] || {};
      if (attachmentKind(incoming) === 'file') {
        const bytes = decodeBase64DataUrl(incoming.dataUrl);
        if (!bytes) throw new Error('That attached file could not be read.');
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`Each attached file must be ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB or smaller.`);
        fileBytes += bytes.length;
        if (fileBytes > MAX_FILES_TOTAL_BYTES) throw new Error(`Attached files must total ${Math.round(MAX_FILES_TOTAL_BYTES / (1024 * 1024))} MB or less.`);
        const extension = safeFileExtension(incoming.name);
        const record = {
          id: crypto.randomUUID(),
          kind: 'file',
          name: fileDisplayName(incoming.name, extension, index),
          mimeType: safeMimeType(incoming.mimeType),
          size: bytes.length,
          extension,
          promptIndex: Math.max(0, Math.min(99, Math.floor(Number(incoming.promptIndex) || 0))),
        };
        const filePath = imageAttachmentPath(taskId, tabId, record);
        fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: 'wx' });
        written.push({ ...record, filePath });
        continue;
      }
      const mimeType = String(incoming.mimeType || '').toLowerCase();
      const type = IMAGE_TYPES[mimeType];
      if (!type) throw new Error('Paste a PNG, JPEG, or WebP image.');
      const prefix = `data:${mimeType};base64,`;
      const dataUrl = String(incoming.dataUrl || '');
      if (!dataUrl.toLowerCase().startsWith(prefix)) throw new Error('That pasted image could not be read.');
      const base64 = dataUrl.slice(prefix.length);
      if (!base64 || !/^[a-z0-9+/]*={0,2}$/i.test(base64)) throw new Error('That pasted image could not be read.');
      const bytes = Buffer.from(base64, 'base64');
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Each pasted image must be 10 MB or smaller.');
      if (!type.matches(bytes)) throw new Error('The pasted file does not match its image format.');
      imageBytes += bytes.length;
      if (imageBytes > MAX_TOTAL_BYTES) throw new Error('Pasted images must total 24 MB or less.');

      const record = {
        id: crypto.randomUUID(),
        name: imageDisplayName(incoming.name, mimeType, index),
        mimeType,
        size: bytes.length,
        promptIndex: Math.max(0, Math.min(99, Math.floor(Number(incoming.promptIndex) || 0))),
      };
      const filePath = imageAttachmentPath(taskId, tabId, record);
      fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: 'wx' });
      written.push({ ...record, filePath });
    }
    return written;
  } catch (error) {
    for (const attachment of written) {
      try { fs.unlinkSync(attachment.filePath); } catch {}
    }
    throw error;
  }
}

// Filesystem-safe, non-escaping name for a file copied into the worktree. No
// separators, no leading dots (which could hide the file or start a traversal).
function safeWorktreeBaseName(name, extension) {
  let base = cleanDisplayName(name)
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!base) base = `attachment${extension || ''}`;
  return base;
}

function uniqueWorktreeName(attachment, usedNames) {
  const original = safeWorktreeBaseName(attachment?.name, attachment?.extension);
  if (!usedNames.has(original)) return original;
  const ext = path.extname(original);
  const stem = original.slice(0, original.length - ext.length) || 'attachment';
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  return `${attachment.id}-${original}`;
}

// The worktree is a live git checkout, so copied attachments would otherwise show
// up as untracked changes in the thread's diff and could be committed by accident.
// Add the subdir to the repo's LOCAL exclude (.git/info/exclude — never a tracked
// file) so it's invisible to git without touching the user's committed .gitignore.
function excludeWorktreeSubdirFromGit(cwd) {
  try {
    const gitDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000,
    }).trim();
    if (!gitDir) return;
    const excludePath = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir), 'info', 'exclude');
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (current.split(/\r?\n/).includes(`${WORKTREE_SUBDIR}/`)) return;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${WORKTREE_SUBDIR}/\n`);
  } catch {
    // Not a git repo, or git unavailable — the copied files simply stay visible.
  }
}

// Codex is cwd-sandboxed and ignores extraDirs, so a file left under DATA_DIR is
// unreadable to it. Copy kind:'file' attachments into <cwd>/supreme-attachments/
// and return the copied absolute paths so the run can point the model at them.
// Images are skipped (they ride --add-dir / -i as before). Best-effort: a file
// that cannot be copied is logged and omitted rather than failing the run.
export function materializeFilesIntoWorktree({ attachments, cwd } = {}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter((attachment) => attachmentKind(attachment) === 'file');
  const base = String(cwd || '').trim();
  if (!files.length || !base) return [];
  const targetDir = path.join(base, WORKTREE_SUBDIR);
  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(targetDir, 0o700); } catch {}
  } catch (error) {
    console.error(`[attachments] could not create ${targetDir}: ${error.message}`);
    return [];
  }
  excludeWorktreeSubdirFromGit(base);
  const copied = [];
  const usedNames = new Set();
  for (const attachment of files) {
    try {
      const source = attachment?.filePath || null;
      if (!source || !fs.existsSync(source)) continue;
      const targetName = uniqueWorktreeName(attachment, usedNames);
      const target = path.join(targetDir, targetName);
      if (target !== targetDir && !target.startsWith(targetDir + path.sep)) continue;
      usedNames.add(targetName);
      fs.copyFileSync(source, target);
      try { fs.chmodSync(target, 0o600); } catch {}
      copied.push(target);
    } catch (error) {
      console.error(`[attachments] could not copy ${attachment?.name || attachment?.id}: ${error.message}`);
    }
  }
  return copied;
}

export function removeTaskImageAttachments(taskId) {
  const safeTask = safeUuid(taskId);
  if (!safeTask) return;
  try { fs.rmSync(path.join(ATTACHMENTS_DIR, safeTask), { recursive: true, force: true }); } catch {}
}

export function removeTabImageAttachments(taskId, tabId) {
  const safeTask = safeUuid(taskId);
  const safeTab = safeUuid(tabId);
  if (!safeTask || !safeTab) return;
  try { fs.rmSync(path.join(ATTACHMENTS_DIR, safeTask, safeTab), { recursive: true, force: true }); } catch {}
}

export function copyTabImageAttachments({ fromTaskId, fromTabId, toTaskId, toTabId, messages } = {}) {
  const records = (Array.isArray(messages) ? messages : [])
    .flatMap((message) => message?.attachments || [])
    .map(imageAttachmentRecord)
    .filter(Boolean);
  if (!records.length) return;
  const targetDirectory = imageDirectory(toTaskId, toTabId);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(targetDirectory, 0o700); } catch {}
  for (const record of records) {
    const source = imageAttachmentPath(fromTaskId, fromTabId, record);
    const target = imageAttachmentPath(toTaskId, toTabId, record);
    if (!source || !target || !fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(target, 0o600); } catch {}
  }
}

export const imageAttachmentLimits = {
  maxImages: MAX_IMAGES,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxFilesTotalBytes: MAX_FILES_TOTAL_BYTES,
};
