// Cloudflare Cron Trigger (15 分毎) → この repo の relay.yml を workflow_dispatch で起こす。
//
// **ここは「起こす」だけ。** 何を起こすか・判定・通知・起票は GitHub 側にある。
// この Worker が持つ GH_DISPATCH_TOKEN は cron-relay 1 repo の Actions: write だけで、
// relay.yml は入力を取らないので、漏れても「監視を余計に回される」以上のことはできない。
// (監視先 repo を直接 dispatch させない理由は README の「なぜ中継を挟むか」)

const RELAY = { repo: 'omochairo/cron-relay', workflow: 'relay.yml' };

export async function dispatchRelay(env) {
  const url = `https://api.github.com/repos/${RELAY.repo}/actions/workflows/${RELAY.workflow}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'omochairo-cron-relay',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { status: 0, ok: false, error: String(e) };
  }
}

async function notifyFailure(env, r) {
  if (!env.NTFY_ALERT_TOPIC) return;
  // fetch のヘッダーは ByteString なので日本語・絵文字の Title を入れると TypeError になる
  // (curl と違う)。ntfy の JSON publish で本文に入れて UTF-8 のまま送る。
  await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: env.NTFY_ALERT_TOPIC,
      title: '🟠 cron-relay: 監視を起こせていない',
      tags: ['warning'],
      priority: 4,
      message: [
        `Cloudflare Worker から relay.yml を dispatch できなかった: HTTP ${r.status}${r.error ? ` (${r.error})` : ''}`,
        '監視は GitHub schedule の間引かれた頻度 (実効 約4h) に落ちている。',
        '401/403 なら GH_DISPATCH_TOKEN (fine-grained PAT) の失効・権限を疑う。',
      ].join('\n'),
    }),
  }).catch((e) => console.log(`ntfy notify failed: ${e}`));
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.GH_DISPATCH_TOKEN) {
      // 未設定を黙って成功にしない (失効・設定漏れは赤で知りたい)。
      throw new Error('GH_DISPATCH_TOKEN is not set');
    }
    const r = await dispatchRelay(env);
    console.log(`relay dispatch -> ${r.status}`);
    if (r.ok) return;
    // 失敗通知は毎正時だけ (最大 1 時間 1 通)。失効したトークンで 15 分毎に鳴らさない。
    // 検知まで最大 1 時間遅れるが、どのみち digest と relay の赤でも見える。
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      await notifyFailure(env, r);
    }
    throw new Error(`relay dispatch failed: HTTP ${r.status}`);
  },
};
