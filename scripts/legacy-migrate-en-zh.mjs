/**
 * 一次性迁移脚本：把原来的「中英双语字段」数据拆成单语种内容包。
 *
 *   data/qa.json / destinations.json / policy.json  +  本文件里的 ui / verdict 文案
 *        ↓
 *   data/i18n/en.json, data/i18n/zh.json
 *
 * 之后 en.json / zh.json 就是母版；其它语种由翻译流程产出，结构必须与 en 完全一致
 * （由 tests/i18n.test.js 强制校验）。
 *
 * ⚠️ 一次性脚本，产物已入库。重跑会覆盖 data/i18n/en.json 与 zh.json，
 *    并且不会带上后来手工补的键，**不要随手重跑**。
 * 运行：node scripts/legacy-migrate-en-zh.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const QA = read('data/legacy/qa.json');
const DEST = read('data/legacy/destinations.json');
const POLICY = read('data/legacy/policy.json');

const pick = (v, lang) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v[lang] || '' : '');

/* ---------------------------------------------------------------- UI 文案 */

const UI_EN = {
  'app.name': 'China Inbound',
  'app.tagline': 'Visa verdict · Answers · Tax refund',
  'app.lang': 'Language',

  'nav.explore': 'Explore',
  'nav.ask': 'Ask',
  'nav.prep': 'Prepare',
  'nav.arr': 'In China',
  'nav.dep': 'Leaving',

  'exp.heading': 'Explore',
  'exp.sub': 'See China first, plan later',
  'exp.hero.badge': 'FIRST TIME IN CHINA',
  'exp.hero.title': 'Start with &ldquo;I&rsquo;d like to go&rdquo;<br>No questions asked yet',
  'exp.hero.body':
    'We don&rsquo;t ask your nationality, your dates or your budget. Look around. When you&rsquo;re tempted, we&rsquo;ll work out whether you can come.',
  'exp.season.heading': 'When to come',
  'exp.season.em': 'weather vs crowds',
  'exp.season.1m': 'Mar&ndash;Apr',
  'exp.season.1d': 'Cherry blossom, mild, crowds picking up',
  'exp.season.2m': 'May / Sep&ndash;Oct',
  'exp.season.2d': 'The two universally agreed best windows',
  'exp.season.3m': 'November',
  'exp.season.3d': 'Late autumn, fewer people, lower prices',
  'exp.season.4m': 'Spring Festival / May Day / National Day',
  'exp.season.4d': 'Domestic travel peaks &mdash; tickets and crowds max out',
  'exp.policy.heading': 'Visa &amp; entry, at a glance',
  'exp.policy.em': 'overview, not a verdict',
  'exp.policy.cta': 'Check my situation in 30 seconds &rarr;',
  'exp.flow.heading': 'From &ldquo;I&rsquo;d like to go&rdquo; to &ldquo;I&rsquo;m through the gate&rdquo;',
  'exp.flow.em': 'the whole road, 5 steps',
  'exp.flow.cta': 'See the full step-by-step &rarr;',

  'ask.heading': 'Ask',
  'ask.sub': 'Tell me what&rsquo;s holding you back',
  'ask.intro':
    'Booking doesn&rsquo;t stall on paperwork. It stalls on a worry you haven&rsquo;t been able to get a straight answer to. Ask in your own words &mdash; or tap one below.',
  'ask.placeholder': 'Type your question&hellip;',
  'ask.send': 'Send',
  'ask.judge.heading': 'Will it work for me?',
  'ask.judge.note':
    'This box answers exactly one thing: <b>whether your specific trip clears the rules.</b> The verdict is computed by an engine, not written by the model.',
  'ask.judge.cta': 'Work out my case &darr;',
  'ask.next.cta': 'Says I can come &mdash; what next &rarr;',

  'fld.nationality': 'Nationality',
  'fld.passport': 'Passport type',
  'fld.purpose': 'Purpose',
  'fld.days': 'Days of stay',
  'fld.port': 'Port of entry',
  'fld.next': 'Leaving to',
  'opt.passport.ord': 'Ordinary passport',
  'opt.passport.other': 'Travel document / emergency certificate',
  'opt.purpose.tour': 'Tourism',
  'opt.purpose.biz': 'Business',
  'opt.purpose.fam': 'Family visit',
  'opt.purpose.exg': 'Exchange visit',
  'opt.purpose.tr': 'Transit to a third country',
  'opt.purpose.work': 'Work / study / journalism',
  'opt.next.home': 'Home / back the same way',
  'opt.next.third': 'A third country or region',
  'opt.port.PVG': 'Shanghai Pudong',
  'opt.port.PEK': 'Beijing Capital',
  'opt.port.CAN': 'Guangzhou Baiyun',
  'opt.port.HAK': 'Haikou (Hainan)',
  'opt.port.SYX': 'Sanya (Hainan)',
  'opt.port.SZX': 'Shenzhen Bao&rsquo;an',

  'prep.heading': 'Prepare',
  'prep.sub': 'You&rsquo;ve decided. Now, in order.',
  'prep.no_trip': '<b>No trip planned yet?</b> Go back to Explore, or check whether you can come visa-free.',
  'prep.explore': 'Explore',
  'prep.route.title': 'Your entry route',
  'prep.route.verdict': 'Verdict',
  'prep.route.expiry': 'Entry window closes',
  'prep.route.count': 'Stay counted from',
  'prep.route.count_value': '00:00 next day',
  'prep.before.heading': 'Before you fly',
  'prep.before.1': 'Install <b>WeChat</b> and finish registration &mdash; it usually needs a +86 SMS code',
  'prep.before.2': 'Set up <b>Alipay / WeChat Pay</b> with your foreign card, and <b>tell your bank</b> you&rsquo;ll be in China',
  'prep.before.3': 'Buy a <b>travel eSIM with overseas routing</b>, or enable international roaming',
  'prep.before.4': 'Save <b>offline translation packs</b> and a photo of your hotel&rsquo;s name and address in Chinese',
  'prep.before.5': 'Keep the same evidence as your stated purpose &mdash; invitation letter, hotel and flight bookings',
  'prep.imm.heading': 'Immigration card &mdash; where people fumble',
  'prep.imm.1k': 'Surname / given name',
  'prep.imm.1v': 'Surname first, then given name',
  'prep.imm.2k': 'Document number',
  'prep.imm.2v': 'Your passport number',
  'prep.imm.3k': 'Date format',
  'prep.imm.3v': '12 Oct 2026 (not 10/12)',
  'prep.imm.4k': 'Accommodation address',
  'prep.imm.4v': 'Hotel name + city is enough',
  'prep.time.heading': 'Countdown',
  'prep.time.1t': 'T&minus;45 days',
  'prep.time.1d': 'Check the visa verdict again &mdash; policies can change',
  'prep.time.2t': 'T&minus;30 days',
  'prep.time.2d': 'Book flights and the first stay',
  'prep.time.3t': 'T&minus;14 days',
  'prep.time.3d': 'Payments, data, translation &mdash; set up and test at home',
  'prep.time.4t': 'T&minus;1 day',
  'prep.time.4d': 'Offline the essentials; screenshot addresses',

  'arr.heading': 'On the ground',
  'arr.sub': 'The things that can actually go wrong',
  'arr.reg':
    '<b>Where you stay must be registered.</b> Hotels do it for you. If you stay with friends or in a rented apartment, <b>you</b> must register at the local police station within <b>24 hours</b> &mdash; Chinese citizens do not, foreign guests do. Fines can reach CNY 2,000.',
  'arr.hotel.title': 'If a hotel says it &ldquo;can&rsquo;t take foreigners&rdquo;',
  'arr.hotel.body':
    'That claim is not a rule. Chinese hotels are <b>not required</b> to hold a special licence to host foreign guests. Don&rsquo;t argue &mdash; show this.',
  'arr.hotel.cta': 'Show the front desk &rarr;',
  'arr.nums.title': 'Numbers worth saving now',
  'arr.nums.1k': '<b>12367</b> &middot; immigration hotline, multilingual',
  'arr.nums.1v': 'entry, stay, registration',
  'arr.nums.2k': '<b>110</b> / <b>120</b> / <b>119</b>',
  'arr.nums.2v': 'police / ambulance / fire',
  'arr.nums.3k': 'Your embassy in China',
  'arr.nums.3v': 'lost documents, emergencies',
  'arr.dayone':
    '<b>One thing to do on day one:</b> after you enter, register your ID once to generate the <b>tax refund service code</b> &mdash; this is what makes refunds one-scan later. Do it while you have Wi-Fi and time, not at a shop counter.',

  'dep.heading': 'Leaving',
  'dep.sub': 'Refunds: eligibility and deadlines, nothing else',
  'dep.note':
    'This screen does <b>no transactions</b> &mdash; no refunds, no advancing money, no agents. It answers two things only: do you qualify, and by what date you must leave.',
  'dep.when.title': 'When did you shop?',
  'dep.two.title': 'Two routes, two deadlines',
  'dep.two.k1': 'Refund-on-the-spot<br>(needs a credit-card pre-authorisation)',
  'dep.two.v1': 'leave within 28 days<br>of the purchase date',
  'dep.two.k2': 'Refund at the departure port',
  'dep.two.v2': 'separate, longer deadline',
  'dep.merge':
    '<b>Do not merge these two numbers.</b> Mixing up the two deadlines is the single most common reason refunds fail. The threshold is <b>CNY 200</b> per store per day, and over <b>8,000</b> stores now offer refund-on-the-spot.',
  'dep.before.title': 'Before you buy',
  'dep.before.body':
    '1 &nbsp;Look for the <b>Tax Free</b> sign at the shop.<br>2 &nbsp;Confirm your card <b>can do a pre-authorisation</b> &mdash; no card, no refund-on-the-spot.<br>3 &nbsp;Note the <b>exact purchase date</b> &mdash; the 28 days start there, not from your flight.',

  'ui.bookable.yes': 'Passport bookable online',
  'ui.bookable.partial': 'Some need counter check',
  'ui.bookable.no': 'Counter only',
  'ui.bookable.na': 'No booking needed',
  'ui.booking.required': 'Booking required',
  'ui.booking.verified': 'Verified',
  'ui.booking.unverified': 'Not yet verified',
  'ui.feedback.q': 'Was this useful?',
  'ui.feedback.yes': 'Yes',
  'ui.feedback.no': 'No',
  'ui.feedback.thanks': 'Thanks &mdash; noted.',
  'ui.feedback.improve': 'Thanks &mdash; we&rsquo;ll improve this one.',
  'ui.src.button': 'Source &amp; date behind this answer',
  'ui.src.default':
    'Rule-based questions are answered by a deterministic engine over a versioned policy base. Every answer shows its source and date.',
  'ui.fallback.src':
    'I answer only from a verified policy base. Unverified questions are escalated, not improvised.',
  'ui.bot.intro':
    'Hi. I&rsquo;m your China trip assistant.<br><br>Ask me anything that&rsquo;s stopping you from booking &mdash; safety, phones, visas, money, language. If it&rsquo;s a rule-based question, I&rsquo;ll give you a <b>definite answer with the source</b>, not a guess.',
  'ui.me': 'You',
  'ui.status.connected': 'API live · policy v{version}',
  'ui.status.failed': 'API unavailable: {msg}',
  'ui.status.offline.title': 'Backend not running',
  'ui.status.offline.body':
    'The page loaded, but the data API is not responding.<br>Run <code>npm start</code> in the project folder, then reload.',
  'ui.tax.leave_by': 'Leave by {date}',
  'ui.tax.expired': 'Deadline passed',
  'ui.tax.critical': 'Cutting it close',
  'ui.tax.ok': 'Comfortable',
  'ui.tax.deadline_row': 'Deadline (28 days from purchase)',
  'ui.tax.purchase_row': 'Purchase date',
  'ui.tax.status_row': 'Status',
  'ui.tax.left': 'Shopping on this date, you have {days} days left to leave.',
  'ui.tax.over': 'The 28-day window for this purchase date has closed. If you already took the advance refund, it must be returned and a late fee may apply.',

  'ov.title': 'Please read this at the front desk',
  'ov.body':
    'Hello. I am a foreign guest with a valid passport and a valid Chinese visa / visa-free entry.<br><br>Chinese hotels are <b>not required to hold a special licence</b> to accommodate foreign guests. Refusing a foreign guest on the grounds of &ldquo;no foreign-related qualification&rdquo; is not a valid reason.<br><br>Could you please check in my booking, or help me confirm the registration with the local police station?<br><br><b>Thank you.</b>',
  'ov.close': 'Close',

  'live.title': 'Live data',
  'live.weather': 'Weather now',
  'live.fx': 'CNY rate',
  'live.watch': 'Policy source watch',
  'live.changed': 'changed · needs review',
  'live.unchanged': 'no change',
  'live.unreachable': 'unreachable',
  'live.cached': 'cached',
  'live.updated': 'updated {time}',
  'live.refund_note': 'Refund estimate uses the live CNY rate.',
  'live.est': '≈ {amount}',
  'live.source_policy': 'National Immigration Administration · notices',
  'wx.clear': 'Clear',
  'wx.cloudy': 'Cloudy',
  'wx.fog': 'Fog',
  'wx.drizzle': 'Drizzle',
  'wx.rain': 'Rain',
  'wx.snow': 'Snow',
  'wx.storm': 'Thunderstorm',
  'wx.offline': 'weather unavailable'
};

const UI_ZH = {
  'app.name': '入境游',
  'app.tagline': '签证判定 · 答疑 · 退税期限',
  'app.lang': '语言',

  'nav.explore': '探索',
  'nav.ask': '答疑',
  'nav.prep': '准备',
  'nav.arr': '在路上',
  'nav.dep': '离境',

  'exp.heading': '探索',
  'exp.sub': '先看中国有什么，再谈怎么办',
  'exp.hero.badge': '第一次来中国',
  'exp.hero.title': '从「想去」开始<br>不用先回答任何问题',
  'exp.hero.body': '这里不问你国籍、不问你几天、不问你预算。等你看完心动了，我们再来算你能不能来。',
  'exp.season.heading': '什么时候来最好',
  'exp.season.em': '天气 vs 人流',
  'exp.season.1m': '3&ndash;4 月',
  'exp.season.1d': '樱花与回暖，人开始多',
  'exp.season.2m': '5 月 / 9&ndash;10 月',
  'exp.season.2d': '公认最舒服的两段',
  'exp.season.3m': '11 月',
  'exp.season.3d': '深秋、人少、价低',
  'exp.season.4m': '春节 / 五一 / 国庆',
  'exp.season.4d': '国内出行高峰，票价与景区人流到顶',
  'exp.policy.heading': '政策 · 我能来吗',
  'exp.policy.em': '概览，不是判定',
  'exp.policy.cta': '30 秒算一下我的情况 &rarr;',
  'exp.flow.heading': '流程 · 从想去到落地',
  'exp.flow.em': '全程五步',
  'exp.flow.cta': '看完整的准备清单 &rarr;',

  'ask.heading': '答疑',
  'ask.sub': '说说你在犹豫什么',
  'ask.intro':
    '订不下来一张机票，通常不是因为流程不会办，是某个顾虑没人给过一句准话。用你自己的话问，或点下面一条。',
  'ask.placeholder': '输入你的问题…',
  'ask.send': '发送',
  'ask.judge.heading': '我这种情况能不能去',
  'ask.judge.note':
    '这一栏只回答一件事：<b>按你的具体情况，走不走得通。</b>结论由引擎算，不由模型随口写。',
  'ask.judge.cta': '用我的情况算一遍 &darr;',
  'ask.next.cta': '结论是「能来」，接下来怎么走 &rarr;',

  'fld.nationality': '国籍',
  'fld.passport': '护照类型',
  'fld.purpose': '出行目的',
  'fld.days': '计划停留天数',
  'fld.port': '入境口岸',
  'fld.next': '离境后前往',
  'opt.passport.ord': '普通护照',
  'opt.passport.other': '旅行证 / 临时证件',
  'opt.purpose.tour': '旅游观光',
  'opt.purpose.biz': '经商',
  'opt.purpose.fam': '探亲访友',
  'opt.purpose.exg': '交流访问',
  'opt.purpose.tr': '过境前往第三国',
  'opt.purpose.work': '工作学习采访',
  'opt.next.home': '回国 / 原路返回',
  'opt.next.third': '第三国或地区',
  'opt.port.PVG': '上海浦东',
  'opt.port.PEK': '北京首都',
  'opt.port.CAN': '广州白云',
  'opt.port.HAK': '海口',
  'opt.port.SYX': '三亚',
  'opt.port.SZX': '深圳宝安',

  'prep.heading': '出行准备',
  'prep.sub': '决定了要去之后，按顺序做这几件事',
  'prep.no_trip': '<b>还没有行程？</b>先去「探索」看看中国，或去「答疑」算一下你能不能免签。',
  'prep.explore': '探索',
  'prep.route.title': '你的入境路径',
  'prep.route.verdict': '结论',
  'prep.route.expiry': '政策有效期至',
  'prep.route.count': '停留自何处起算',
  'prep.route.count_value': '入境次日零时',
  'prep.before.heading': '出发前',
  'prep.before.1': '装好 <b>微信</b> 并完成注册——这一步通常需要 +86 短信验证码',
  'prep.before.2': '用境外卡绑好 <b>支付宝 / 微信支付</b>，并<b>提前告知发卡行</b>你要去中国',
  'prep.before.3': '买一张<b>走境外路由的旅行 eSIM</b>，或开通国际漫游',
  'prep.before.4': '下载<b>离线翻译包</b>，并给酒店的中文名与地址截个图',
  'prep.before.5': '随身带与事由相符的材料——邀请函、机酒订单',
  'prep.imm.heading': '入境卡 · 最容易填错的地方',
  'prep.imm.1k': '姓名顺序',
  'prep.imm.1v': '姓在前、名在后',
  'prep.imm.2k': '证件号',
  'prep.imm.2v': '填护照号',
  'prep.imm.3k': '日期格式',
  'prep.imm.3v': '12 Oct 2026（别写 10/12）',
  'prep.imm.4k': '住址',
  'prep.imm.4v': '酒店名 + 城市即可',
  'prep.time.heading': '时间线倒排',
  'prep.time.1t': 'T&minus;45 天',
  'prep.time.1d': '再核一次签证结论——政策会变',
  'prep.time.2t': 'T&minus;30 天',
  'prep.time.2d': '订机票与首段住宿',
  'prep.time.3t': 'T&minus;14 天',
  'prep.time.3d': '支付、网络、翻译——在家里装好并试通',
  'prep.time.4t': 'T&minus;1 天',
  'prep.time.4d': '离线化必要内容；把地址截图',

  'arr.heading': '在路上',
  'arr.sub': '会真的出事的那几件',
  'arr.reg':
    '<b>住哪里必须登记。</b>住酒店由酒店办；住亲友家或租的公寓，<b>必须由你本人</b>在 <b>24 小时内</b>到当地派出所办理。中国人不用，外国人要。罚则可达 2000 元。',
  'arr.hotel.title': '如果酒店说「不能接待外国人」',
  'arr.hotel.body': '这句话不成立。中国酒店接待外国客人<b>不需要</b>专门资质。不用争辩——把这段给他看。',
  'arr.hotel.cta': '显示给前台看 &rarr;',
  'arr.nums.title': '现在就存下来的号码',
  'arr.nums.1k': '<b>12367</b> &middot; 移民管理局热线，多语种',
  'arr.nums.1v': '出入境、居留、登记',
  'arr.nums.2k': '<b>110</b> / <b>120</b> / <b>119</b>',
  'arr.nums.2v': '警察 / 急救 / 火警',
  'arr.nums.3k': '你本国驻华使领馆',
  'arr.nums.3v': '证件丢失、紧急情况',
  'arr.dayone':
    '<b>落地第一天做一件事：</b>入境后录入一次身份信息，生成<b>离境退税服务码</b>——后面退税一码通刷靠的是它。在有网、有空的时候做，别等到商场收银台。',

  'dep.heading': '离境',
  'dep.sub': '退税：只做判定与期限，不碰交易',
  'dep.note':
    '这一屏<b>没有任何交易</b>——不退款、不垫付、不代办。只回答两件事：你够不够格，最晚几号必须走。',
  'dep.when.title': '购物日期是哪天？',
  'dep.two.title': '两种退法，两个期限',
  'dep.two.k1': '即买即退<br>（须办信用卡预授权）',
  'dep.two.v1': '自购物之日起<br>28 天内离境',
  'dep.two.k2': '离境口岸退税',
  'dep.two.v2': '另一套，期限更长',
  'dep.merge':
    '<b>这两个数字不要并成一个。</b>把两种期限记混，是退税失败最常见的原因。起退点为同一店铺同日消费 <b>200 元</b>，全国「即买即退」商店已超 <b>8000 家</b>。',
  'dep.before.title': '购物前的三个动作',
  'dep.before.body':
    '1 &nbsp;认店门口的 <b>Tax Free</b> 标识。<br>2 &nbsp;确认你的卡<b>能做预授权</b>——没有卡，现场退不了。<br>3 &nbsp;记住<b>准确的购物日期</b>——28 天从这天起算，不从航班日算。',

  'ui.bookable.yes': '护照可线上订',
  'ui.bookable.partial': '部分需窗口核验',
  'ui.bookable.no': '仅窗口可订',
  'ui.bookable.na': '无需预约',
  'ui.booking.required': '需预约',
  'ui.booking.verified': '已实测',
  'ui.booking.unverified': '待实测',
  'ui.feedback.q': '这条有用吗？',
  'ui.feedback.yes': '有用',
  'ui.feedback.no': '没用',
  'ui.feedback.thanks': '收到，谢谢。',
  'ui.feedback.improve': '收到，我们会改进这条。',
  'ui.src.button': '这条回答的依据与日期',
  'ui.src.default': '规则类问题由确定性引擎在版本化政策库上作答。每条回答都会给出依据与日期。',
  'ui.fallback.src': '我只从已核验的政策库作答。未核验的问题不走即兴发挥。',
  'ui.bot.intro':
    '你好，我是你的来华行程助手。<br><br>任何让你订不下机票的顾虑都可以问我——安全、手机、签证、付钱、语言。凡是规则类的问题，我会给你<b>带依据的确定答案</b>，不猜。',
  'ui.me': '你',
  'ui.status.connected': 'API 已连接 · 政策 v{version}',
  'ui.status.failed': 'API 连接失败：{msg}',
  'ui.status.offline.title': '后端未启动',
  'ui.status.offline.body': '页面已加载，但数据接口不可用。<br>请在项目目录运行 <code>npm start</code>，再刷新本页。',
  'ui.tax.leave_by': '最晚 {date} 离境',
  'ui.tax.expired': '已超过期限',
  'ui.tax.critical': '临近期限',
  'ui.tax.ok': '时间充裕',
  'ui.tax.deadline_row': '期限（28 天，从购物日起算）',
  'ui.tax.purchase_row': '购物日',
  'ui.tax.status_row': '状态',
  'ui.tax.left': '按此日期购物，你还有 {days} 天可以离境。',
  'ui.tax.over': '该购物日期对应的 28 天期限已过。若已领取预付金，需退回并可能产生滞纳金。',

  'ov.title': '请把这段给前台看',
  'ov.body':
    'Hello. I am a foreign guest with a valid passport and a valid Chinese visa / visa-free entry.<br><br>Chinese hotels are <b>not required to hold a special licence</b> to accommodate foreign guests. Refusing a foreign guest on the grounds of &ldquo;no foreign-related qualification&rdquo; is not a valid reason.<br><br>Could you please check in my booking, or help me confirm the registration with the local police station?<br><br><b>Thank you.</b>',
  'ov.close': '关闭',

  'live.title': '实时数据',
  'live.weather': '实时天气',
  'live.fx': '实时汇率',
  'live.watch': '政策源监测',
  'live.changed': '有变化 · 待人工复核',
  'live.unchanged': '无变化',
  'live.unreachable': '无法访问',
  'live.cached': '缓存',
  'live.updated': '更新于 {time}',
  'live.refund_note': '退税估算按实时汇率折算。',
  'live.est': '≈ {amount}',
  'live.source_policy': '国家移民管理局 · 通知公告',
  'wx.clear': '晴',
  'wx.cloudy': '多云',
  'wx.fog': '雾',
  'wx.drizzle': '小雨',
  'wx.rain': '雨',
  'wx.snow': '雪',
  'wx.storm': '雷雨',
  'wx.offline': '天气暂不可用'
};

/* ------------------------------------------------------- 判定引擎文案模板 */

const V_EN = {
  'v.title.visa_required': 'Visa required',
  'v.title.not_covered': 'Not covered by visa-free rules',
  'v.title.unilateral': 'Visa-free entry',
  'v.title.unilateral_over': 'Eligible, but you&rsquo;d overstay the limit',
  'v.title.mutual': 'Visa-free entry',
  'v.title.mutual_over': 'Over the mutual-agreement limit',
  'v.title.transit': '240-hour transit visa-free',
  'v.title.transit_over': 'Transit scheme only gives 10 days',
  'v.title.transit_not_met': 'Transit conditions not met',
  'v.title.hainan': 'Hainan 30-day visa-free',

  'v.why.work':
    'Working, studying or reporting in China falls outside <b>every</b> visa-free arrangement and needs the matching visa before you travel, regardless of length of stay.',
  'v.why.passport':
    'Visa-free entry applies only to holders of a <b>valid ordinary passport</b>. Travel documents and temporary or emergency certificates are <b>not</b> eligible under either the unilateral visa-free or the transit visa-free scheme.',
  'v.why.unilateral':
    'Under the <b>unilateral visa-free policy</b> (50 countries), holders of an ordinary passport may enter visa-free for business, tourism, family visits, exchange or transit, for a stay of <b>no more than 30 days</b>.',
  'v.why.unilateral_over':
    '<b>{country}</b> is indeed on the 50-country list &mdash; but visa-free entry allows <b>no more than 30 days</b>, and you plan {days} days. <b>The excess does not work.</b>',
  'v.why.mutual':
    'Under the <b>mutual visa exemption agreement</b> between China and <b>{country}</b>, holders of an ordinary passport may enter visa-free, generally for <b>no more than 30 days</b>.',
  'v.why.mutual_over':
    'The mutual agreement with <b>{country}</b> generally caps the stay at 30 days; you plan {days} days.',
  'v.why.transit':
    'You are a citizen of <b>{country}</b> and your itinerary is origin &rarr; China &rarr; <b>a third country or region</b>, which meets the <b>240-hour transit visa-free</b> conditions.',
  'v.why.transit_over':
    'Your transit conditions hold, but the 240-hour scheme caps the stay at <b>10 days</b> and you plan {days} days.',
  'v.why.transit_not_met':
    'The 240-hour scheme requires origin &rarr; China &rarr; <b>a third country or region</b>. <b>Your destination is home / back the same way, so origin and destination are the same country &mdash; that is not transit.</b>',
  'v.why.hainan':
    'As a citizen of <b>{country}</b> entering via a Hainan port open to foreigners, you may stay visa-free for up to 30 days <b>within Hainan province</b>.',
  'v.why.visa_required':
    'Under the conditions you selected, <b>{country}</b> does not qualify under the current unilateral visa-free, mutual agreement, 240-hour transit or Hainan schemes.',

  'v.p.work.type': 'Visa type follows the purpose (Z work / X study / J journalist)',
  'v.p.work.centre': 'Filed through a Chinese Visa Application Service Centre',
  'v.p.work.lead': 'Allow 4&ndash;6 weeks',
  'v.p.pp.apply': 'Apply for the matching visa, or travel on a valid ordinary passport',
  'v.p.uni.days': '30 days allowed; you plan {days} days &mdash; within the limit',
  'v.p.uni.midnight': 'The stay counts from <b>00:00 the day after entry</b>',
  'v.p.uni.ports': 'Applies at all ports open to foreigners',
  'v.p.uni.vs_transit':
    'You also qualify for the <b>240-hour transit visa-free</b> &mdash; but the unilateral scheme gives you <b>30 days</b>. We compared: this one is better for you.',
  'v.p.expiry.warn': '<b>Trial policy &mdash; runs only to {expires}</b>',
  'v.p.expiry.none': 'No fixed expiry date under the current arrangement',
  'v.p.uni.evidence': 'Carry evidence matching your purpose (invitation, bookings)',
  'v.p.uni.trim': 'Trim to 30 days or less &rarr; enter visa-free',
  'v.p.uni.need_visa': 'Keep {days} days &rarr; you need a visa (L tourist / M business)',
  'v.p.uni.leave30': 'The stay counts from the day after entry; you must leave by day 30',
  'v.p.mutual.days': '30 days allowed; you plan {days} days',
  'v.p.mutual.lists': 'Mutual agreements and the unilateral list are <b>two separate lists</b> &mdash; don&rsquo;t mix them',
  'v.p.mutual.official': 'Names and durations are subject to the latest official publication',
  'v.p.mutual.compress': 'Under 30 days &rarr; visa-free',
  'v.p.mutual.visa': 'Otherwise a visa is needed',
  'v.p.tr.days': 'Up to 240 hours (10 days); you plan {days} days',
  'v.p.tr.ticket': 'You must hold a connecting ticket with confirmed dates',
  'v.p.tr.ports': 'Entry at any of <b>65 open ports</b> across 24 provinces',
  'v.p.tr.provinces': 'Travel is limited to the 24 covered provinces; cross-province travel allowed',
  'v.p.tr.exclusions':
    'Not available to those previously refused a Chinese visa or with illegal entry/exit records within 5 years',
  'v.p.tr.compress': 'Under 10 days &rarr; 240-hour transit works',
  'v.p.tr.visa': 'Need longer &rarr; a visa is required',
  'v.p.trn.qualify': 'As a citizen of {country} you would qualify &mdash; but you must genuinely go on to a third country',
  'v.p.trn.change': 'Change &ldquo;leaving to&rdquo; to a third country and recompute',
  'v.p.trn.normal': 'Just a return trip to China &rarr; apply for a normal visa',
  'v.p.hn.port': 'Your chosen port qualifies',
  'v.p.hn.only': '<b>Travel is limited to Hainan only</b> &mdash; if you also want Shanghai or Guangzhou, this route fails',
  'v.p.vr.purpose': 'Choose the visa by purpose (L tourist / M business / Q family)',
  'v.p.vr.centre': 'Filed via a Chinese Visa Application Service Centre; allow 4&ndash;6 weeks',
  'v.p.vr.hainan': 'If you&rsquo;re only going to Hainan and enter via Haikou or Sanya, Hainan&rsquo;s 30-day visa-free applies',
  'v.p.vr.transit': 'If your trip continues to a third country or region with a connecting ticket, consider the <b>240-hour transit visa-free</b>',
  'v.byline':
    'Engine output, not model output. Basis: National Immigration Administration announcement, Aug 2026; policy set expires 31 Dec 2026 for 48 of the 50 countries.'
};

const V_ZH = {
  'v.title.visa_required': '需要办理签证',
  'v.title.not_covered': '免签政策不适用',
  'v.title.unilateral': '可以免签入境',
  'v.title.unilateral_over': '你有免签资格，但停留超限',
  'v.title.mutual': '可以免签入境',
  'v.title.mutual_over': '互免协定停留超限',
  'v.title.transit': '可以走 240 小时过境免签',
  'v.title.transit_over': '过境免签只给 10 天',
  'v.title.transit_not_met': '过境条件不成立',
  'v.title.hainan': '可走海南 30 天免签',

  'v.why.work': '来华<b>工作、学习、采访报道</b>不属于任何免签政策范围，必须在来华前办妥相应签证，与停留天数无关。',
  'v.why.passport':
    '免签仅适用于持<b>有效普通护照</b>者。持旅行证、临时或紧急证件等普通护照以外的证件，<b>不适用</b>单方面免签与过境免签。',
  'v.why.unilateral':
    '依据<b>单方面免签政策</b>（50 国），持普通护照来华经商、旅游观光、探亲访友、交流访问、过境，停留<b>不超过 30 天</b>可免签入境。',
  'v.why.unilateral_over':
    '<b>{country}</b>确实在单方面免签 50 国名单内——但免签只允许停留 <b>不超过 30 天</b>，你计划 {days} 天，<b>超出的部分走不通</b>。',
  'v.why.mutual':
    '依据中国与 <b>{country}</b> 之间的<b>互免签证协定</b>，持普通护照可免签入境，停留一般<b>不超过 30 天</b>。',
  'v.why.mutual_over': '中国与 <b>{country}</b> 的互免签证协定停留上限一般为 30 天，你计划 {days} 天。',
  'v.why.transit':
    '你是 <b>{country}</b> 公民，行程为「出发地 → 中国 → <b>第三国或地区</b>」，符合 <b>240 小时过境免签</b>条件。',
  'v.why.transit_over': '你的过境条件成立，但 240 小时免签的上限是 <b>10 天</b>，你计划 {days} 天。',
  'v.why.transit_not_met':
    '240 小时过境免签要求行程为「出发地 → 中国 → <b>第三国或地区</b>」。<b>你的目的地是回国 / 原路返回，出发地与目的地为同一国家，不构成过境。</b>',
  'v.why.hainan':
    '你是 <b>{country}</b> 公民，从海南省对外开放口岸入境，可在<b>海南省行政区域内</b>免签停留不超过 30 天。',
  'v.why.visa_required':
    '按你选择的行程条件，<b>{country}</b>不符合现行的单方面免签、互免协定、240 小时过境免签或海南免签。',

  'v.p.work.type': '签证类型按事由选择（Z 工作 / X 学习 / J 记者）',
  'v.p.work.centre': '需通过中国签证申请服务中心递交',
  'v.p.work.lead': '建议预留 4&ndash;6 周受理周期',
  'v.p.pp.apply': '请办理相应签证，或更换为有效普通护照',
  'v.p.uni.days': '可停留 30 天，你计划 {days} 天，符合',
  'v.p.uni.midnight': '停留时间自<b>入境次日零时</b>起算',
  'v.p.uni.ports': '适用于所有对外国人开放的海陆空口岸',
  'v.p.uni.vs_transit':
    '你同时符合 <b>240 小时过境免签</b>条件——但单方面免签给你 <b>30 天</b>，我们已替你比较，这条更有利。',
  'v.p.expiry.warn': '<b>该政策为「试行」，施行至 {expires}</b>',
  'v.p.expiry.none': '现行安排未设固定截止日期',
  'v.p.uni.evidence': '建议随身携带邀请函、机酒订单等与事由相符的证明材料',
  'v.p.uni.trim': '把行程压到 30 天以内 → 可直接免签入境',
  'v.p.uni.need_visa': '坚持 {days} 天 → 需要申请签证（L 旅游 / M 商务）',
  'v.p.uni.leave30': '停留时间自入境次日起算，第 30 天必须离境',
  'v.p.mutual.days': '可停留 30 天，你计划 {days} 天，符合',
  'v.p.mutual.lists': '互免协定与单方面免签是两套名单，不要混用',
  'v.p.mutual.official': '协定名单与期限以官方最新公布为准',
  'v.p.mutual.compress': '压缩到 30 天以内 → 可免签入境',
  'v.p.mutual.visa': '否则需申请签证',
  'v.p.tr.days': '可停留不超过 240 小时（10 天），你计划 {days} 天，符合',
  'v.p.tr.ticket': '须持<b>确定日期及行程的联程客票</b>',
  'v.p.tr.ports': '可从 24 个省份、<b>65 个开放口岸</b>中任一口岸入境',
  'v.p.tr.provinces': '活动范围限政策覆盖的 24 个省份，可跨省旅行',
  'v.p.tr.exclusions': '曾被中国签证机关拒签、或 5 年内有非法出入境等记录者不适用',
  'v.p.tr.compress': '压到 10 天以内 → 可走 240 小时过境免签',
  'v.p.tr.visa': '需要更长时间 → 必须申请签证',
  'v.p.trn.qualify': '你是 {country} 公民，本来可以走这条——但必须真实前往第三国',
  'v.p.trn.change': '若确实要前往第三国，请把「离境后前往」改为第三国重算',
  'v.p.trn.normal': '只是往返中国 → 请按普通签证办理',
  'v.p.hn.port': '你选择的入境口岸符合条件',
  'v.p.hn.only': '<b>活动范围仅限海南省</b>——若还要去上海、广州等地，这条走不通',
  'v.p.vr.purpose': '请按出行事由选择签证类型（L 旅游 / M 商务 / Q 探亲等）',
  'v.p.vr.centre': '通过中国签证申请服务中心递交，建议预留 4&ndash;6 周',
  'v.p.vr.hainan': '若你只去海南、并从海口或三亚入境，可享 <b>海南 30 天免签</b>',
  'v.p.vr.transit': '若行程包含前往第三国或地区、且持联程客票，可考虑 <b>240 小时过境免签</b>',
  'v.byline':
    '引擎输出，非模型输出。依据：国家移民管理局 2026-08 公告；50 国中 48 国政策施行至 2026-12-31。'
};

/* ------------------------------------------------------------- 内容投影 */

function projectQA(lang) {
  return QA.items.map((it) => {
    const out = {
      id: it.id,
      action: it.action,
      k: it.k,
      q: pick(it.q, lang),
      a: pick(it.a, lang),
      li: (it.li && (it.li[lang] || it.li.en) || []).slice()
    };
    // 原数据里 phone 的 warn 是布尔 true，文案缺失 —— 这里补成真文案
    if (it.id === 'phone' && it.warn) {
      out.warn =
        lang === 'zh'
          ? '<b>VPN 必须出发前装好。</b>到了中国，VPN 服务商网站本身打不开，落地再装是装不上的。'
          : '<b>Install the VPN before you fly.</b> Once you are in China, VPN provider sites do not open &mdash; you cannot download one on arrival.';
    } else if (typeof it.warn === 'object') {
      out.warn = pick(it.warn, lang);
    }
    if (it.fees) out.fees = (it.fees[lang] || it.fees.en).slice();
    if (it.tips) out.tips = (it.tips[lang] || it.tips.en).slice();
    if (it.tail) out.tail = pick(it.tail, lang);
    if (it.yes) out.yes = true;
    out.src = pick(it.src, lang);
    return out;
  });
}

function projectDest(lang) {
  return {
    version: DEST.version,
    checkedAt: DEST.checkedAt,
    disclaimer: pick(DEST.disclaimer, lang) || DEST.disclaimer,
    categories: DEST.categories.map((c) => ({ id: c.id, name: pick(c, lang) })),
    items: DEST.items.map((d) => ({
      id: d.id,
      cat: d.cat,
      title: pick(d.title, lang),
      desc: pick(d.desc, lang),
      badges: d.badges.map((b) => pick(b, lang)),
      booking: {
        reservationRequired: d.booking.reservationRequired,
        passportOnline: d.booking.passportOnline,
        note: pick(d.booking.note, lang),
        verified: d.booking.verified
      }
    })),
    seasons: DEST.seasons.map((s) => ({ months: pick(s.months, lang), desc: pick(s.desc, lang), warn: s.warn }))
  };
}

function projectPolicy(lang) {
  return {
    version: POLICY.version,
    checkedAt: POLICY.checkedAt,
    source: POLICY.source,
    expiry: POLICY.expiry,
    stats: POLICY.stats.map((s) => ({ value: s.value, unit: s.unit, label: pick(s.label, lang), hot: s.hot })),
    notes: POLICY.notes.map((n) => ({ tone: n.tone, text: pick(n.text, lang) })),
    steps: POLICY.steps.map((s) => ({
      n: s.n,
      title: pick(s.title, lang),
      desc: pick(s.desc, lang),
      when: pick(s.when, lang),
      hot: s.hot
    }))
  };
}

/* ---------------------------------------------------------------- 输出 */

const packs = [
  { code: 'en', name: 'English', native: 'English', ui: UI_EN, v: V_EN, reviewStatus: 'native' },
  { code: 'zh', name: 'Chinese', native: '简体中文', ui: UI_ZH, v: V_ZH, reviewStatus: 'native' }
];

fs.mkdirSync(path.join(ROOT, 'data/i18n'), { recursive: true });

for (const p of packs) {
  const pack = {
    code: p.code,
    name: p.name,
    native: p.native,
    reviewStatus: p.reviewStatus,
    dir: 'ltr',
    ui: p.ui,
    verdict: p.v,
    qa: projectQA(p.code),
    dest: projectDest(p.code),
    policy: projectPolicy(p.code)
  };
  const out = path.join(ROOT, `data/i18n/${p.code}.json`);
  fs.writeFileSync(out, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  console.log('wrote', path.relative(ROOT, out), fs.statSync(out).size, 'bytes');
}
