# 共享 AI 端点

**当前状态：AI 功能对所有人开放**，按来源 IP 每天 10 次计额度。邮箱登录的整套
东西（发码、验证、token、套餐、额度）都还在，但没有启用：`worker.js` 里
`REQUIRE_AUTH = false`。要打开，把它改成 `true`，同时把 `build_site.py` 的
`AUTH_URL` 指回 Worker 地址——只改一边会得到一个「页面要验证码但接口不要」或
反过来的组合。启用前必须先配好下面的邮件服务，否则没人登得进来。


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

## 可分享的报告

AI 页跑完识别后有一个「生成可分享的报告」按钮：把打分明细、匹配职业与获邀率、
加分建议和数据口径排成一页，存进 KV，返回 `/r/<32位十六进制>` 的链接，30 天后
自动删除。

**这个链接本身就是凭证**，没有别的校验——所以 id 是 CSPRNG 出来的 128 位，页面
带 `noindex, nofollow`。

两件在 `report.js` 里刻意处理的事，改这个文件时别绕过：

- **不信任任何输入。** 数据来自浏览器、又要作为页面从你的域名渲染回去，所以
  `clean()` 把每个字段重新定型、限长、限数量，形状之外的键一律丢弃，输出一律
  过 `esc()`。已实测注入 `<script>` / `<img onerror>` 全部被转义。
- **不重新计算。** 数字用页面上已经给用户看过的那份。报告和它来源的那一屏对不上，
  比没有报告更糟。

限流：每 IP 每天 20 份，单份 60 KB 上限。

**发到用户邮箱这一步还没做**，因为它和验证码一样需要一个验证过的发件域名。域名
到位后，`auth.js` 里的 `sendCode` 就是现成的样板，把链接放进正文即可。

## 报告发到用户邮箱

Worker 发不了信（没有 SMTP 出口），而 HTTP 邮件 API 都要求验证发件域名。
GitHub Actions 的 runner 可以直连 `smtp.gmail.com` 并**以账号本人身份**登录，
这时候信是 Google 替你发的，SPF/DKIM 天然对齐，不需要任何域名。所以发信这一步
放在 Action 里。

流程：页面填邮箱 → Worker 存报告、存一条待发记录、调 GitHub API 触发
`repository_dispatch` → Action 拉起 `scripts/send_report_mail.py` → 脚本凭
`DISPATCH_SECRET` 向 Worker 取收件人和正文 → 用 Gmail SMTP 发出 → 回调
`/pending/done` 删除记录。

**收件人地址不进 dispatch payload**：这个仓库是公开的，workflow run 附带的
一切也是公开的。payload 只有一个不透明的报告 id，地址由 runner 回头来取，
日志里也只打印打码后的地址。

需要的密钥：

| 放在哪 | 名字 | 说明 |
|---|---|---|
| Worker | `DISPATCH_SECRET` | 已生成，本地副本 `~/.immi-dispatch-secret` |
| Worker | `GH_REPO` | 已设为 `yyxr75/immi-analysis` |
| Worker | `GH_DISPATCH_TOKEN` | **待配**：细粒度 PAT，只给这一个仓库 |
| Actions | `DISPATCH_SECRET` | 和 Worker 里那个一模一样 |
| Actions | `MAIL_USER` | 发信用的 Gmail 地址 |
| Actions | `MAIL_PASS` | **Gmail App Password**，不是账号密码 |

限制，别忽略：Gmail 免费账号每天约 500 个收件人；**Google 条款不允许用 Gmail
做批量商业发信**，低量事务性邮件实际没人管，有规模会被限流。这是过桥方案，
真做起来还是要回到一个自己的域名 + 正规邮件服务。

另：Worker 里有一个 `RESENT_API_KEY`（拼写少了 D），代码只读
`RESEND_API_KEY`，所以它从来没生效过。现在不用 Resend，可以删掉：
`wrangler secret delete RESENT_API_KEY`。

## 密钥清单

| 名字 | 用途 | 谁生成 |
|---|---|---|
| `PROVIDER_API_KEY` | DeepSeek，实际调模型 | 你 |
| `AUTH_SECRET` | 签 token、算邮箱哈希 | 已生成，存在 `~/.immi-auth-secret` |
| `ADMIN_TOKEN` | 调 `/auth/grant` | 已生成，存在 `~/.immi-admin-token` |
| `RESEND_API_KEY` | 发验证码 | **待配** |
| `MAIL_FROM` | 发件人 | **待配** |
| `MAIL_REPLY_TO` | 回信地址（可选，不设就没有这个头） | 可选 |

**换掉 `AUTH_SECRET` 会让所有人当场退出登录**（旧 token 全部验不过），账户本身
不会丢，重新登录即可。

## 查配置对不对

Secret 的名字是手打的，打错了是**静默失败**：值存进去了，代码读的是另一个名字，
表现和从没配过一模一样。这个坑已经踩过两次（`RESENT_API_KEY`、
`GH_DISPATCH_TOEKN`），所以有个自查接口——只报「有没有」，绝不回显值：

```bash
ADM=$(cat ~/.immi-admin-token)
curl -s -X POST https://immi-occupation-match.yyxr75.workers.dev/admin/config \
  -H 'Origin: https://yyxr75.github.io' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADM" -d '{}' | python3 -m json.tool
```

`features` 那一段直接告诉你哪些功能真的能用：`ai`、`requireAuth`、
`signInByEmail`、`reportByEmail`。

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
