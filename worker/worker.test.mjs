// node --test worker/worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const at = (hhmm) => Date.parse(`2026-09-26T${hhmm}:00Z`);

function stubFetch(status) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    // 実際の fetch と同じく、ヘッダーに ByteString 以外 (日本語・絵文字) があれば TypeError
    new Headers(init.headers);
    calls.push({ url, init });
    const isNtfy = url.includes('ntfy.sh');
    return { status: isNtfy ? 200 : status, ok: isNtfy || (status >= 200 && status < 300) };
  };
  return calls;
}

const env = { GH_DISPATCH_TOKEN: 't', NTFY_ALERT_TOPIC: 'a' };

test('成功時は relay.yml を ref=main・inputs なしで 1 回 dispatch するだけ', async () => {
  const calls = stubFetch(204);
  await worker.scheduled({ scheduledTime: at('07:15') }, env, { waitUntil() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/omochairo/cron-relay/actions/workflows/relay.yml/dispatches');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
});

test('失敗は throw し、ntfy 通知は毎正時だけ', async () => {
  const ctx = { waitUntil() {} };

  let calls = stubFetch(401);
  await assert.rejects(worker.scheduled({ scheduledTime: at('07:15') }, env, ctx), /HTTP 401/);
  assert.ok(!calls.some((c) => c.url.includes('ntfy.sh')));

  calls = stubFetch(401);
  await assert.rejects(worker.scheduled({ scheduledTime: at('08:00') }, env, ctx), /HTTP 401/);
  const ntfy = calls.filter((c) => c.url.includes('ntfy.sh'));
  assert.equal(ntfy.length, 1);
  const msg = JSON.parse(ntfy[0].init.body);
  assert.equal(msg.topic, 'a');
  assert.match(msg.message, /HTTP 401/);
});

test('fetch 自体の例外も失敗として扱う', async () => {
  globalThis.fetch = async () => { throw new Error('network'); };
  await assert.rejects(worker.scheduled({ scheduledTime: at('07:15') }, env, { waitUntil() {} }), /HTTP 0/);
});

test('トークン未設定は黙って成功にしない', async () => {
  stubFetch(204);
  await assert.rejects(worker.scheduled({ scheduledTime: at('07:15') }, {}, { waitUntil() {} }), /GH_DISPATCH_TOKEN/);
});
