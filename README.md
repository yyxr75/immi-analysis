# 澳洲技术移民工具箱

站点名 `澳洲技术移民工具箱`，副标题 `职业数据查询 · Schedule 6D 打分 · 基于 SkillSelect 官方公开数据`。
两者都定义在 `scripts/report_template.html` 顶部的 `SITE_TITLE` / `SITE_TAGLINE` 常量里，
`build_site.py` 和 `build_report.py` 各自复用同一个字符串——改名时这三处要一起改。

## 数据来源

数据源：澳大利亚就业与劳资关系部 SkillSelect EOI 公开看板。页面本身不含数据，
是个 Qlik Sense mashup —— 数据通过 WebSocket 走 Qlik Engine JSON API 取。

- 看板：`https://api.dynamic.reports.employment.gov.au/anonap/extensions/hSKLS02_SkillSelect_EOI_Data/hSKLS02_SkillSelect_EOI_Data.html`
- Qlik app id：`aaac76b5-ad30-477e-9ca0-472f8ab57fc8`（`hSKLS02 SkillSelect EOI Summary Data_LIVE`）
- 覆盖：08/2024 – 07/2026 共 24 个月末快照，1,650,005 个去重 EOI

## 抓取怎么работает

`scripts/qlik.py` 是个极简 Qlik 引擎客户端。两个关键点，踩过坑：

1. **必须先用 HTTPS 请求一次 mashup 页面**拿到匿名会话 cookie
   (`X-Qlik-Session-anonap-HTTP` + F5 粘性 cookie)，再带着它开 WebSocket。
   不带 cookie 也能连上、也能 `OpenDoc`，但字段列表是空的。
2. **`OpenDoc` 的第 5 个参数是 `qNoData`，必须传 `False`。** 传 `True` 会打开一个
   无数据的壳：`DocumentTitle()` 正常返回，`GetAppLayout` 也有最后刷新时间，
   但所有聚合都是 0，非常容易误判成没权限。

看板上的表对象 `eymDb` 带计算条件（未选择时报 error 7005），所以不去读它，
直接用 `cube()` 建自己的 session hypercube。

## 跑法

```bash
python scripts/probe.py                                    # 列出 sheet / 对象
python scripts/extract.py                                  # 全量维度 -> data/*.csv
python scripts/verify.py                                   # 与引擎实时值对账
python scripts/extract_occupation.py "233411 Electronics Engineer"   # 单职业 -> data/occ/
python scripts/prep_report.py       "233411 Electronics Engineer"   # -> output/*.json
python scripts/build_report.py      "233411 Electronics Engineer"   # -> output/*.html
```

后三步换任意 ANZSCO 职业名即可复用（职业全名见
`data/occupation_visa_status.csv` 的 `occupation` 列，共 495 个）。

## 口径（会影响结论，别跳过）

- **池子是累积的。** 每月快照保留已关闭的 EOI，所以总数只增不减。真正的竞争池是
  `EOI Status = SUBMITTED`。
- **各签证类型不可相加。** 一个人可同时对 189/190/491 提交 EOI。
- **状态之间也不可相加。** 同一个 EOI 会先后出现在 SUBMITTED 和 CLOSED 里；
  所有计数必须是 `COUNT(DISTINCT %EOIID)`。
- **`INVITED` 是月末存量，不是邀请流量。** 看板不公布流量。邀请 60 天失效，
  月末快照只抓得到当时还握着有效邀请的人，因此低估真实邀请量；但时间形状可信。
- **`LODGED ⊆ INVITED`**（已用引擎去重并集核实），算"曾获邀"时取两者并集。
- **官方看板屏蔽 <20 的格子**（`vMinCountMask=20`），本地抽的是未屏蔽原始值。
  若要对外发布需重新套用屏蔽。
- 申请人可以改分，同一个 EOI 会落进多个分数桶，获邀率是近似值。

## 站点结构

页面分成三个大类，标签栏切换，hash 路由 `#/<view>[/<职业代码>]`：

| # | 视图 | 内容 |
|---|---|---|
| 1 | **职业数据查询** `#/data/261313` | KPI、关键结论、跨通道对比、六张图 |
| 2 | **计算分数** `#/points/261313` | Schedule 6D 打分器 + 边际分析（见下节） |
| 3 | **AI 分析** `#/ai` | 简历解析：连你自己的 OpenAI 兼容端点，浏览器内脱敏后提取事实 |

### AI 分析页（`scripts/ai_view.js`）

页面本身不含模型，调用**用户自己填的端点**（端点/密钥只存 localStorage）。

**分工是这一页的全部要点：模型只读出简历里写着的事实，所有换算在本地做。**
不是洁癖——首轮实测里模型就把「1996 年生」算成 27 岁、把「PTE 79」判成 Proficient
（实为 Superior）。两处都是换算，现在都由 JS 做。模型现在只填出生年份、考试分数、
工作起止日期这类原值，`aiMap()` 负责算年龄、累计月数、套 Schedule 6D 档位。

**脱敏顺序不能反。** `aiRedact()` 先把日期规范化（`2014.09` → `2014年9月`），
再做长串数字识别。反过来的话 `2014.09 - 2018.07` 会被当成 12 位号码整段抹掉，
工作年限直接丢失——这个 bug 出现过。

**国别判断是模型最容易错的一项。** 它一度因为「配偶持有澳洲永久居留权」就把
中国的工作和学历都标成 australia。system prompt 里现在有专门规则，
schema 也要求 `countryEvidence` 附上判断依据的原文，结果表里直接显示出来供核对。

已知限制：不解析 PDF（需额外库，请粘贴文字）；ANZSCO 匹配是本地关键词匹配，
仅作候选建议。

**职业选择器和签证筛选属于「职业数据查询」视图，不是全站控件。**
「计算分数」是纯打分——分数由 Schedule 6D 决定，与职业无关，所以那一页不提职业，
hash 也不带职业码（`#/points`）。两页之间通过 localStorage 里的分数联通：
打分页有个链接跳到数据页，数据页顶部则显示「你算出的分数：189 = 75 分，
本职业历史获邀率 25.2%」。获邀率是职业属性，只出现在数据页。

旧链接 `#261313` 仍然有效，会自动规范化成 `#/data/261313`。

**注意：图表按容器实际宽度绘制**，所以在隐藏的视图里绘制会得到 0 宽度并退回兜底值。
`setView()` 在切回数据页时重绘图表，站点外壳也必须先 `report.hidden = false` 再 `boot()`。

## 打分器（Schedule 6D）

报告页顶部的打分器是**纯前端确定性运算**，不调用任何模型、不上传任何输入。
规则逐条转录自 **Migration Regulations 1994 Schedule 6D**，
现行编译版 **2026-07-01**（`F1996B03551`，legislation.gov.au）。
每个选项都标注了 Schedule 条目号（6D11/6D21/…），可逐条核对。

规则表在 `scripts/report_template.html` 的 `RULES` 常量里。**法规会改**——
改动时同步更新 `RULES.version` 和条目号，页面会把版本显示给用户。

几个容易算错的地方，已实现并有测试覆盖：
- **6D.5 工作经验合计封顶 20 分**：海外 8 年(15) + 澳洲 8 年(20) ≠ 35，按 20 计。
  边际分析也尊重这个封顶（澳洲经验从 0 到 8 年只能带来 +10 而非 +20）。
- **学历 6D71–6D75 只取一项**，不叠加。
- **配偶 6D111/6D112/6D113 三选一**：单身与「配偶是 PR/公民」同为 10 分。
- 州/地区提名分（190 +5、491 +15）是在基础分之上叠加，不进基础分。

打分器只做算术，随后查该职业该分数段的历史获邀率。它不预测申请结果：
职业评估结论以评估机构为准，190/491 的州提名标准不在本数据集内。

## ⚠️ 月度面板会回填 —— 时间序列不能读增长

`data/coverage_check.csv`（as-at 月份 × EOI 提交年份的交叉表）证明了这一点。
取「2023 年提交」这个**不可能增长的固定集合**：

| as-at 月份 | 2022 年提交 | 2023 年提交 |
|---|---|---|
| 08/2024 | 28,706 | 28,756 |
| 12/2024 | 95,208 | 77,558 |
| 12/2025 | 98,417 | 349,781 |
| 07/2026 | 98,628 | 351,592 |

2023 年那一列涨了 12 倍。所以 `As At Month` **不是**「该月末存活」的快照，
早期月份覆盖严重不全（面板约 2024 年中建起、历史逐步补录）。

**推论：**
- ❌ 不要用按月人数曲线算「池子涨了几倍」——那是在测看板的覆盖度，不是排队量。
  报告里已移除所有增长类 KPI 和结论。
- ✅ `rate.csv`（获邀率）**不带 As At Month 维度**，在完整底层记录上聚合，不受影响。
- ✅ 最新月份（07/2026）的横截面自洽，可用。
- ⚠️ 分位数/热力图是月内比例，受早期样本构成偏差影响，跨月对比要谨慎。
