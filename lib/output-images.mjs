import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWrittenImages } from './written-output.mjs';

const MAX_BYTES = 10 * 1024 * 1024;

export function outputImageReferences(content) {
  return localWrittenImages(content).flatMap((image) => {
    try {
      const filePath = image.target.startsWith('file:') ? fileURLToPath(image.target)
        : image.target.startsWith('~/') ? path.join(os.homedir(), image.target.slice(2)) : image.target;
      if (!path.isAbsolute(filePath) || /[\u0000-\u001f\u007f]/.test(filePath) || !/\.(?:png|jpe?g|webp)$/i.test(filePath)) return [];
      const id = crypto.createHash('sha256').update(image.target).digest('hex');
      return [{ ...image, id, filePath, name: path.basename(filePath) }];
    } catch { return []; }
  });
}

export function publicOutputImages(content, taskId, tabId) {
  return outputImageReferences(content).map(({ target, name, id }) => ({
    target, name, url: `/api/tasks/${taskId}/tabs/${tabId}/output-images/${id}`,
  }));
}

// No path parameter or general filesystem route: only raster images explicitly
// referenced in this tab's saved assistant answers can be opened. Read a bounded
// buffer from one file descriptor and sniff bytes, never trust an extension.
export async function readOutputImage(tab, id) {
  if (!/^[a-f0-9]{64}$/.test(String(id || ''))) return null;
  const reference = (tab?.messages || []).filter((message) => message.role === 'assistant')
    .flatMap((message) => outputImageReferences(message.content)).find((image) => image.id === id);
  if (!reference) return null;
  let handle;
  try {
    handle = await fs.open(reference.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) return null;
    let mimeType;
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
    else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
    else if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mimeType = 'image/webp';
    return mimeType ? { bytes, mimeType } : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
