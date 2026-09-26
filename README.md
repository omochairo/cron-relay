# cron-relay

GitHub Actions の `schedule` が間引いてしまう高頻度の監視を、Cloudflare の Cron Trigger から起こすための中継です (omochairo/amazon-home-ops#84)。

```
Cloudflare Worker (Cron */15)
   │ workflow_dispatch (PAT-A: この repo の Actions: write だけ)
   ▼
cron-relay / relay.yml   ← 入力なし・起こす先は固定
   │ workflow_dispatch (PAT-B: GitHub secret。amazon / amazon-home-ops の Actions: write)
   ├─▶ amazon-home-ops / 90-heartbeat-check.yml   自宅ワーカーの dead-man's switch
   └─▶ amazon / 53-origin-failover.yml            navi のオリジン障害で待機系へ倒す
```

## なぜ必要か

`schedule` の実際の配送数 (#84 の実測。2026-09-19〜25 も変わらず):

| workflow | cron | 期待/日 | 実測/日 |
|---|---|---|---|
| 90-heartbeat-check | `*/15` | 96 | 5〜8 |
| 53-origin-failover | `*/30` | 48 | 5〜7 |

自宅ワーカーの異常検知も、オリジン障害のときの切り替えも、実効間隔が約 4 時間になっていました。
監視先の `schedule` は予備として残してあるので、この中継が止まっても元の頻度 (間引かれた頻度) には戻るだけです。

## なぜ Cloudflare Workers か

| 候補 | 採らなかった理由 |
|---|---|
| 自宅 (NAS / K8 の timer) | 自宅が落ちたことを検知する仕組みなので、判定する箱が一緒に落ちる |
| GitLab CI の pipeline schedule | SaaS runner の無料枠 (400 分/月) では 15 分ごとの実行に足りない。待機系の runner は NAS の上にある |
| GitHub 上で長時間ループ | 実行時間を使い切るうえ、keep-alive 的な使い方になる (アカウント凍結の前例がある) |

## なぜ中継を挟むか (Worker から監視先を直接 dispatch しない理由)

監視先の repo には多数の workflow があり、`workflow_dispatch` の入力を安全に扱っているかをすべて保証し続けることはできません。
入力を `run:` の中へ `${{ }}` で直接展開している workflow が 1 本でもあれば、監視先の **Actions: write** を持つトークンで「任意の入力で dispatch → シェルに注入 → その job の secrets を抜く」ことができます。そうなると、このトークンは実質的に push 権限と同じ強さになります。

それを GitHub の外 (Cloudflare) に置くのは避けました。

- Worker が持つ PAT-A で起こせるのは、この repo の `relay.yml` だけ。`relay.yml` は入力を取らない
- 監視先に届く PAT-B は GitHub の secret に置く。信頼の境界は今までと同じ

PAT-A が漏れた場合に攻撃者ができるのは、次の 2 つだけです。

- 監視を余計に回す
- `relay.yml` を disable する、または run を cancel して中継を止める。この場合は下の「止まったときに気づく経路」で分かり、監視は GitHub schedule の頻度に戻るだけです

secrets を読むことも、コードを走らせることもできません。この前提を崩さないために、次の 2 点を守ってください。

- **`relay.yml` に `inputs` を足さない**
- **`main` 以外のブランチやタグを残さない**。dispatch の `ref` にはこの repo の任意のブランチやタグを指定できるので、試作中の `relay.yml` が残っていると、それを走らせる道になる

## セットアップ (1 回だけ)

### 1. PAT を 2 本作る (fine-grained / Resource owner: omochairo / 有効期限 1 年)

| 名前 | Repository access | Permissions | 置き場所 |
|---|---|---|---|
| PAT-A `cron-relay-worker` | Only select → `cron-relay` | Actions: Read and write | Worker の secret `GH_DISPATCH_TOKEN` |
| PAT-B `cron-relay-monitors` | Only select → `amazon`, `amazon-home-ops` | Actions: Read and write | この repo の secret `MONITOR_DISPATCH_PAT` |

```bash
gh secret set MONITOR_DISPATCH_PAT -R omochairo/cron-relay
```

### 2. 中継単体で動くことを確かめる

```bash
gh workflow run relay.yml -R omochairo/cron-relay
```

```bash
gh run list -R omochairo/amazon-home-ops -w 90-heartbeat-check.yml -e workflow_dispatch -L 3
```

### 3. Worker を配備する

```bash
cd worker
npx wrangler@4 login
npx wrangler@4 deploy
npx wrangler@4 secret put GH_DISPATCH_TOKEN
npx wrangler@4 secret put NTFY_ALERT_TOPIC
```

`GH_DISPATCH_TOKEN` には PAT-A を渡します。`NTFY_ALERT_TOPIC` は amazon-home-ops の secret と同じ値で、dispatch に失敗したときの通知先です。

## 止まったときに気づく経路

- Worker の dispatch が失敗すると、ntfy の alert topic に毎正時通知が来る (401/403 は PAT-A の失効)
- `relay.yml` の run が赤になる (PAT-B の失効や権限不足)
- amazon-home-ops の日次 digest の「checker 実行率」の内訳で、dispatch が 0 になる

## テスト

```bash
node --test worker/worker.test.mjs
```
