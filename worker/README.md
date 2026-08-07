# 公共 AI 服务（Cloudflare Worker）

让访客不用自己填 API Key 就能用「AI 分析」页，费用由你承担。

**为什么必须有这一层：** 站点是 GitHub Pages 上的纯静态站，页面能读到的东西访客
就能读到。把 Key 写进配置文件 = 公开 Key，而且会永久留在 git 历史里。爬公开仓库和
页面找 Key 的机器人一直在跑，通常几小时内就会被捡走，之后别人拿它干什么都算你的账单。
Key 只能待在服务端，这个 Worker 就是那个服务端。

## 它不是一个通用代理

浏览器只发 `{ "text": "<脱敏后的简历正文>" }`。模型、prompt、schema 全部由 Worker
自己拼。所以就算 Worker 地址泄漏，别人拿到的也只是「职业识别」这一个功能，还带着限额，
而不是一个免费的模型接口。

`spec.generated.js` 由 `scripts/build_worker_spec.py` 从 `scripts/ai_view.js` 生成，
保证两侧的 prompt/schema 是同一份——**不要手改**，改 `ai_view.js` 后重新生成。

## 部署

```bash
cd worker
npm i -g wrangler && wrangler login

# 1. 建限流用的 KV，把打印出的 id 填进 wrangler.toml
npx wrangler kv namespace create RATE

# 2. 放入 API Key（只存在 Cloudflare，不进仓库）
npx wrangler secret put PROVIDER_API_KEY

# 3. 发布
npx wrangler deploy
```

拿到形如 `https://immi-occupation-match.<你的子域>.workers.dev` 的地址后，填进
`scripts/build_site.py` 的 `PUBLIC_PROXY_URL`，重新 `python build_site.py` 并推送。
**这个地址是 URL 不是凭证，可以公开。** 填好后「AI 分析」页会多出「公共服务（无需填 Key）」
选项并作为默认；留空则该选项不出现。

## 限额

`worker.js` 顶部三个常量：

| 常量 | 默认 | 作用 |
|---|---|---|
| `PER_IP_PER_DAY` | 20 | 单 IP 每日次数 |
| `GLOBAL_PER_DAY` | 500 | **全站每日总量——你的预算闸门** |
| `MAX_CHARS` | 12000 | 单次输入上限 |

`ALLOWED_ORIGINS`（`wrangler.toml`）限制哪些站点能调。留空等于放开，不建议。

超额时页面会提示访客改用自己的 Key，功能不会整个不可用。

先按你能接受的日预算估：DeepSeek 一次识别约 700–900 tokens，`GLOBAL_PER_DAY=500`
的量级很小，但**这是硬闸门，请按自己的账单容忍度调**。
