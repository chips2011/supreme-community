import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOpenThreadLink } from '../desktop/open-thread-links.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'supreme-community-links-'));
const originalDataDir = process.env.WORKBENCH_HOME;
process.env.WORKBENCH_HOME = scratch;
try {
  const { supremeLink } = await import('../lib/email.mjs');
  const link = supremeLink('thread-123', 'tab-456');
  assert.equal(link, 'supreme-community://open?thread=thread-123&tab=tab-456');
  assert.deepEqual(parseOpenThreadLink(link), { taskId: 'thread-123', tabId: 'tab-456' });
  assert.equal(parseOpenThreadLink(supremeLink('../escape', 'tab')), null);
  assert.deepEqual(parseOpenThreadLink('supreme://open?thread=legacy&tab=saved'), { taskId: 'legacy', tabId: 'saved' });
  console.log('PASS: Slack/email links round-trip into OG Supreme; unsafe IDs are rejected and legacy links remain readable.');
} finally {
  if (originalDataDir === undefined) delete process.env.WORKBENCH_HOME;
  else process.env.WORKBENCH_HOME = originalDataDir;
  rmSync(scratch, { recursive: true, force: true });
}
