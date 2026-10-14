import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePublishDirectory } from './check-publish.mjs';

function fixture(payload = { schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [], relations: [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-publish-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'void 0');
  fs.writeFileSync(path.join(root, 'index.html'), `<script id="kms-data" type="application/json">${JSON.stringify(payload)}</script><script src="./assets/app.js"></script>`);
  return root;
}

test('accepts the known static output shape', (t) => { const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true })); assert.equal(validatePublishDirectory(root).assets, 1); });
test('rejects malformed or placeholder payloads', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.html'), '<script id="kms-data">/*__KMS_DATA__*/</script>');
  assert.throws(() => validatePublishDirectory(root), /자리표시자/);
});
test('rejects extras, internal files, and missing referenced assets', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'x'); assert.throws(() => validatePublishDirectory(root), /최상위/); fs.rmSync(path.join(root, 'secret.txt'));
  fs.writeFileSync(path.join(root, 'assets', 'config.json'), '{}'); assert.throws(() => validatePublishDirectory(root), /관리/); fs.rmSync(path.join(root, 'assets', 'config.json'));
  fs.writeFileSync(path.join(root, 'index.html'), '<script id="kms-data">{"schemaVersion":2,"items":[],"relations":[]}</script><script src="./assets/missing.js"></script>');
  assert.throws(() => validatePublishDirectory(root), /자산/);
});
test('rejects arbitrary files inside assets', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'assets', 'notes.md'), 'internal');
  assert.throws(() => validatePublishDirectory(root), /정적 자산 형식/);
  fs.rmSync(path.join(root, 'assets', 'notes.md'));
  fs.writeFileSync(path.join(root, 'assets', 'payload.json'), '{}');
  assert.throws(() => validatePublishDirectory(root), /정적 자산 형식/);
});
test('rejects symlinks when the platform permits creating one', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  try { fs.symlinkSync(path.join(root, 'assets', 'app.js'), path.join(root, 'assets', 'alias.js'), 'file'); }
  catch { t.skip('symlink creation is not permitted'); return; }
  assert.throws(() => validatePublishDirectory(root), /심볼릭/);
});
test('rejects an output root that is itself a symlink when permitted', (t) => {
  const root = fixture(); const link = `${root}-link`; t.after(() => { try { fs.rmSync(link, { recursive: true, force: true }); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  try { fs.symlinkSync(root, link, 'junction'); }
  catch { t.skip('directory symlink creation is not permitted'); return; }
  assert.throws(() => validatePublishDirectory(link), /자체가 심볼릭 링크/);
});
