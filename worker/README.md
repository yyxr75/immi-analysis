# 共享 AI 端点 + 邮箱登录

站点是静态的，任何密钥放进页面就等于公开。所以调用模型的密钥、账号体系和
额度统计全部在这个 Worker 里，浏览器只拿到一个「这个邮箱能收到信」的凭证。

## 部署后还差什么

登录要发验证码，Worker 自己发不了邮件，需要一个邮件服务。**没配之前，
`/auth/request` 会明确返回 503，不会把验证码写进日志**——那等于谁能看日志谁
就能登录。

默认用 [Resend](https://resend.com)（免费额度每天 100 封 / 每月 3000 封）：

1. 注册 Resend，**Domains** 里加上你的域名并按提示加 DNS 记录验证。
   没有域名也可以先用它给的 `onboarding@resend.dev`，但那个只能发给你自己
   注册时用的邮箱，只够自测。
2. **API Keys** 里建一个 key，权限选 *Sending access* 就够。
3. 写进 Worker（**不要粘贴到聊天里或提交进仓库**）：

   ```bash
   cd worker
   source ~/.cf-token
   wrangler secret put RESEND_API_KEY      # 粘贴 key，回车
   wrangler secret put MAIL_FROM           # 例如：澳洲移民工具箱 <no-reply@你的域名>
   ```

4. 验证一下：

   ```bash
   curl -s -X POST https://immi-occupation-match.yyxr75.workers.dev/auth/request \
     -H 'Origin: https://yyxr75.github.io' -H 'Content-Type: application/json' \
     -d '{"email":"你自己的邮箱"}'
   # 期望 {"ok":true,"ttl":600}，然后邮箱收到 6 位验证码
   ```

换别家（Brevo / SendGrid / Mailgun 都行）只需要改 `auth.js` 里的 `sendCode`
一个函数，其余不用动。

## 密钥清单

| 名字 | 用途 | 谁生成 |
|---|---|---|
| `PROVIDER_API_KEY` | DeepSeek，实际调模型 | 你 |
| `AUTH_SECRET` | 签 token、算邮箱哈希 | 已生成，存在 `~/.immi-auth-secret` |
| `ADMIN_TOKEN` | 调 `/auth/grant` | 已生成，存在 `~/.immi-admin-token` |
| `RESEND_API_KEY` | 发验证码 | **待配** |
| `MAIL_FROM` | 发件人 | **待配** |

**换掉 `AUTH_SECRET` 会让所有人当场退出登录**（旧 token 全部验不过），账户本身
不会丢，重新登录即可。

## 给某人开通付费

```bash
ADM=$(cat ~/.immi-admin-token)
curl -s -X POST https://immi-occupation-match.yyxr75.workers.dev/auth/grant \
  -H 'Origin: https://yyxr75.github.io' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADM" \
  -d '{"email":"someone@example.com","plan":"paid","until":"2027-01-01"}'
```

`until` 到期后自动降回免费，账户不删。改回免费用 `"plan":"free"`。
返回里带一个该邮箱的 token，可以直接给收不到信的人用。

## 额度与成本

`worker.js` 顶部三个数字决定花多少钱：

- `PLANS.free = 10`、`PLANS.paid = 200`（每账户每天）
- `GLOBAL_PER_DAY = 400`（全站每天，最后一道闸）
- `MAX_CHARS = 40000`（单次简历长度上限）

理论最坏是 `GLOBAL_PER_DAY × MAX_CHARS`。提示词里那 492 条职业清单每次请求
都一样，DeepSeek 的前缀缓存会接住（实测 4096/4166 token 命中缓存），所以清单
基本不额外计费。

**KV 免费额度是每天 1000 次写**，登录流程本身也要写（验证码、限流计数、额度
计数）。`GLOBAL_PER_DAY` 定在 400 就是为了给登录留出余量；要往上调，先看
Cloudflare 面板里的 KV 写入量。

## 端点

| 路径 | 需要 | 说明 |
|---|---|---|
| `POST /auth/request` | — | `{email}`，发验证码 |
| `POST /auth/verify` | — | `{email, code}`，换 30 天 token |
| `POST /auth/me` | Bearer | 当前账号、套餐、今日余量 |
| `POST /auth/grant` | Bearer = `ADMIN_TOKEN` | 开通/取消付费 |
| `POST /` | Bearer | `{text}`，职业识别 |

所有路径都受 `wrangler.toml` 里 `ALLOWED_ORIGINS` 的来源白名单限制。
