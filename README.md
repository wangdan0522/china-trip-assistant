# 入境游 APP（全栈版 · 多语种 + 实时数据）

面向外国游客的签证判定 / 答疑 / 退税期限服务。零外部依赖，只用 Node 内置模块，`npm start` 就能跑。

```
node >= 18（用了全局 fetch / Intl.DisplayNames / node:test）
npm start          # http://127.0.0.1:8787
npm run verify     # 54 个单测 + 70 项端到端冒烟（实时源打桩，离线可跑）
npm run live:check # 真实联网自检三个上游源
npm run i18n:coverage
```

## 多语种（6 种）

`en / zh / ja / ko / es / ru`。切换在页面右上角，也支持 `?lang=ja` 直达、`Accept-Language` 自动协商。

```
data/i18n/<lang>.json   # 单语种内容包：ui(179键) + verdict(57键) + qa(7条) + dest + policy
server/i18n.js          # 语言注册 / 协商 / 回退 / 判定结论渲染
```

三条设计规则：

1. **引擎不产出自然语言。** 判定引擎只产出「消息键 + 参数」（`v.title.unilateral` + `{days:45}`），翻译在 i18n 层完成——加语种不可能改错规则。
2. **键集合跨语种强一致。** `tests/i18n.test.js` 校验 179 个 UI 键、57 个判定键、占位符 `{days}`、qa 结构在六个语种完全一致；非英文包与英文重复率超 15% 判为「没翻译」直接报错。
3. **国家名不维护对照表。** 46 国国名用 ICU（`Intl.DisplayNames`）按当前语言本地化。

回退链：缺键 → 英文 → 显式标记 `⟦key⟧`（测试会把任何 `⟦` 残留判为失败）。
ja/ko/es/ru 四包 `reviewStatus: "draft"`，为机翻初稿，上线前需母语校订；en/zh 为 `native`。

## 实时数据（三类，策略各不同）

| 源 | 用途 | TTL | 失败行为 |
|---|---|---|---|
| MET Norway（备源 Open-Meteo） | 目的地实时天气 | 10 分钟 | 降级缓存并标 `stale` |
| open.er-api.com | 退税到手金额估算 | 6 小时 | 没有汇率就只报人民币，不编数 |
| 国家移民管理局官网 | 政策源变化监测 | 30 分钟 | **只做变化检测 + 人工复核，绝不自动改规则** |

- 天气做了**双源互备**：主源挂了自动切备源（实测当前网络 Open-Meteo 不通、MET Norway 通）。
- 全部函数永不抛异常；`/api/health` 给出每个源的 ok / stale / ageSec / error。
- 政策监测抓官方页政策相关标题做哈希，变化即挂「待人工复核」——法律结论不能来自 HTML 解析，这是产品红线。
- 退税估算按净退税率 9%（退税率 11% 扣约 2% 手续费），只作心理预期。

## 判定引擎（`server/policy-engine.js`）

纯函数、可注入时间、非法输入一律拒绝（不猜）。覆盖：单方面免签 50 国（含文莱「无期限」、俄罗斯 2027）、240 小时过境免签（含「原路返回不构成过境」）、互免协定（优先级高于海南免签，因为给的是全国 30 天）、海南 30 天免签（仅限海南口岸与省内）、工作学习采访一律需签证、非普通护照不适用。政策到期倒计时按自然日差。

## 结构

```
server/
  index.js         路由 / 语言协商 / 安全响应头 / 限流
  i18n.js          语种注册 / 协商 / 回退 / 结论渲染
  policy-engine.js 判定引擎（只产消息键）
  content.js       答疑 / 目的地 / 政策概览（按语种取包）
  live.js          天气双源 / 汇率 / 政策源监测 / 退税估算
  taxfree.js       28 天期限计算
  store.js         反馈 JSONL（换 Postgres 不动接口）
data/
  countries.json   46 国 f/t/h/m 标记
  i18n/*.json      6 个语种包（唯一文案源）
  places.json      天气坐标（与目的地 id 对应）
  sources.json     实时源配置
  legacy/          旧双语数据（迁移源，不再被读取）
public/            无框架前端；文案全部来自 /api/ui
tests/             engine(24) + i18n(13) + live(17) + smoke(70项)
scripts/           live-check 联网自检；legacy-migrate-* 为一次性迁移脚本，勿重跑
```

## API

```
GET  /api/health /api/languages /api/ui?lang /api/meta?lang /api/countries?lang
GET  /api/questions?lang /api/destinations?lang /api/policy?lang /api/live /api/stats
POST /api/eligibility {countryCode,passportType,purpose,stayDays,port,next,lang}
POST /api/ask {id | text, lang}
POST /api/taxfree {shoppingDate, amount?, currency?, lang}
POST /api/feedback {answerId, helpful, lang}
POST /api/live/refresh {source: weather|fx|policy|all}
```

深链：`/?lang=ja`（指定语言）、`/#ask`（直达 tab）、`/?lang=ru&demo=judge#ask`（带判定结果）、`/?lang=zh&demo=12000#dep`（带退税估算）。

## 上线前必做

1. 政策数据接官方结构化源（带生效日/失效日/来源/复核日，过期自动下架）——现在是人工核对版本 `2026.08`。
2. ja/ko/es/ru 母语校订；政策类句子（verdict 包）优先。
3. store.js → Postgres；静态资源 → CDN；限流 → Redis；HTTPS + CSP 收紧（当前允许内联脚本以支持无构建前端）。
4. 答疑接 LLM 分流：规则类走引擎，体验类走模型，模型输出必须标「非引擎输出」。
