import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { adminTextChunks, normalizeDigits } from '../src/admin-text.js';

const codes = chunk => chunk.formattingEntities.map(entity => {
  assert.ok(entity instanceof Api.MessageEntityCode);
  return chunk.message.slice(entity.offset, entity.offset + entity.length);
});

test('commands and their arguments are individually copyable, excluding labels and prose', () => {
  const text = '📋 منو\n81 — Backup: /data export\n84 — Replace: /data import replace confirm\n/pause then /resume.\n/source list\n22 — Add: /source add REF\n/rule RULE_NUMBER|all forwards on|off';
  const [chunk] = adminTextChunks(text);
  assert.equal(chunk.message, text);
  assert.deepEqual(codes(chunk), ['/data export', '/data import replace confirm', '/pause', '/resume', '/source list', '/source add REF', '/rule RULE_NUMBER|all forwards on|off']);
});

test('markup, names and URLs are never interpreted as HTML or Markdown', () => {
  const [chunk] = adminTextChunks('<b>Name</b> `x` [click](tg://user?id=1)\n/errors');
  assert.deepEqual(codes(chunk), ['/errors']);
  assert.equal(chunk.message, '<b>Name</b> `x` [click](tg://user?id=1)\n/errors');
});

test('long messages retain code entities, whole commands and UTF-16 boundaries', () => {
  const text = 'a'.repeat(3495) + '/data import merge confirm\n' + 'b'.repeat(3472) + '📋 /menu';
  const chunks = adminTextChunks(text);
  assert.equal(chunks.map(chunk => chunk.message).join(''), text);
  assert.ok(chunks.every(chunk => chunk.message.length <= 3500));
  assert.deepEqual(chunks.flatMap(codes), ['/data import merge confirm', '/menu']);
  const emojiChunks = adminTextChunks('a'.repeat(3499) + '📋 /menu');
  assert.equal(emojiChunks[0].message.length, 3499);
  assert.ok(emojiChunks[1].message.startsWith('📋'));
});

test('English, Persian and Arabic digits normalize consistently', () => {
  assert.equal(normalizeDigits('81 ۸۲ ٨٣'), '81 82 83');
});
