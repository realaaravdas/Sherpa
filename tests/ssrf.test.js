import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl, safeGet } from '../src/scraper/http.js';

test('private/loopback/metadata addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', 'fe80::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});
test('assertPublicUrl rejects dangerous URLs', () => {
  for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'ftp://a/b', 'http://user:pw@example.com/', 'http://[::1]/', 'http://foo.internal/', 'not a url']) assert.throws(() => assertPublicUrl(u), u);
  assert.doesNotThrow(() => assertPublicUrl('https://example.com/careers'));
});
test('safeGet refuses hostnames that resolve to private addresses', async () => {
  await assert.rejects(() => safeGet('http://localtest.me/'), /./); // resolves to 127.0.0.1 (or fails DNS) — either way must not connect
});
