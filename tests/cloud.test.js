'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cloudSource = fs.readFileSync(path.join(__dirname, '../public/cloud.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const calls = { sends: [], verifies: [], queries: [], creates: [], initialized: [], signOut: 0 };
  let session = options.session || null;
  let authListener;
  const sdk = {
    auth: {
      sendOtp: async (input) => { calls.sends.push(input); return options.sendOtp ? options.sendOtp(input) : options.sendResult || { data: { verificationId: 'challenge-1', isExistingUser: options.existing !== false }, error: null }; },
      verifyOtp: async (input) => {
        calls.verifies.push(input);
        if (options.verifyError && calls.verifies.length === 1) return { error: options.verifyError };
        if (options.establishSession !== false) session = { user: { id: 'user-1' } };
        return { data: { user: { id: 'not-trusted-until-session' } }, error: null };
      },
      getSession: async () => options.getSession ? options.getSession() : { data: session, error: null },
      signOut: async () => { calls.signOut++; session = null; authListener('SIGNED_OUT', null); return { error: null }; },
      onAuthStateChange: (listener) => { authListener = listener; }
    },
    database: {
      from(table) {
        const call = { table };
        calls.queries.push(call);
        const builder = {
          select(columns) { call.select = columns; return builder; },
          insert(row) { call.insert = row; return builder; },
          order(column, order) { call.order = [column, order]; return builder; },
          limit(count) { call.limit = count; return builder; },
          then(yes, no) { return Promise.resolve(options.databaseResult || { data: call.insert && table === 'inbound_history' ? [{ id: 'row-1', ...call.insert }] : [], error: null }).then(yes, no); }
        };
        return builder;
      }
    },
    llm: {
      models: { list: async () => options.models || [{ id: 'disabled', disabled: true }, { id: 'off', enabled: false }, { id: 'usable' }] },
      chat: { completions: { create(input) {
        calls.creates.push(input);
        return options.stream ? options.stream(input) : (async function* () {
          yield { choices: [{ delta: { content: '<img src=x onerror=bad()>你好' } }] };
          yield { choices: [{ delta: { content: '世界' }, finish_reason: 'stop' }] };
        })();
      } } }
    }
  };
  const elements = new Map();
  const intervals = [];
  const listeners = {};
  function element() {
    const events = {};
    return {
      textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, children: [], style: {},
      attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key]; },
      removeAttribute(key) { delete this.attributes[key]; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(name, callback) { events[name] = callback; },
      fire(name, event = {}) { return events[name] && events[name].call(this, event); },
      reportValidity() { return true; }, checkValidity() { return true; }
    };
  }
  const context = vm.createContext({
    console, URL, URLSearchParams, AbortController, Date, Intl,
    location: { origin: options.origin || 'https://app.example', search: options.search || '', hash: '' },
    navigator: { language: options.browserLang || 'en' },
    fetch: (...args) => options.fetch ? options.fetch(...args) : Promise.reject(new Error('离线测试未配置 fetch')),
    INBOUND_PUBLIC_CONFIG: { publicConfig: { endpoint: 'https://app.example', oauthRelayBaseUrl: 'https://relay.example', publishableKey: 'public-test-key' } },
    WorkBuddyCloud: { createWorkBuddyCloud(input) { calls.initialized.push(input); return sdk; } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, addEventListener(name, callback) { listeners[name] = callback; },
      querySelectorAll() { return []; }, querySelector() { return null; }, hidden: false, documentElement: {}, body: element() },
    setTimeout, clearTimeout, setInterval(callback, delay) { intervals.push({ callback, delay }); },
    localStorage: { getItem() { return options.savedLang || null; }, setItem() {} }
  });
  context.window = context;
  vm.runInContext(cloudSource, context);
  if (options.app) vm.runInContext(appSource, context);
  return { context, api: context.AppCloud, calls, elements, element, intervals, listeners,
    emit: (event, value) => authListener(event, value), $: (id) => context.document.getElementById(id) };
}

for (const existing of [true, false]) {
  test(`邮箱 OTP ${existing ? '已有用户' : '新用户'}：提交只验证已保存 challenge，不重发`, async () => {
    const h = harness({ existing });
    await h.api.sendCode('traveller@example.test');
    assert(h.api.remaining() > 0);
    await h.api.verifyCode('traveller@example.test', '123456');
    assert.equal(h.calls.sends.length, 1);
    assert.equal(h.calls.verifies.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.verifies[0])), { email: 'traveller@example.test', token: '123456', verificationId: 'challenge-1', isExistingUser: existing });
    assert.equal((await h.api.getSession()).user.id, 'user-1');
    assert.equal(h.calls.initialized.length, 1);
    assert.equal(h.calls.initialized[0].endpoint, 'https://app.example');
    assert.equal(h.calls.initialized[0].oauthRelayBaseUrl, 'https://relay.example');
    vm.runInContext(cloudSource, h.context);
    assert.equal(h.calls.initialized.length, 1);
  });
}

test('错误验证码重试复用 challenge，倒计时不阻止验证', async () => {
  const h = harness({ verifyError: { kind: 'verification_failed' } });
  await h.api.sendCode('traveller@example.test');
  await assert.rejects(h.api.verifyCode('traveller@example.test', '000000'));
  await h.api.verifyCode('traveller@example.test', '123456');
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.verifies.length, 2);
  assert.equal(h.calls.verifies[0].verificationId, h.calls.verifies[1].verificationId);
});

test('未发送、变更邮箱、发送失败均不触发验证；verify 返回用户不代表登录', async () => {
  const h = harness({ establishSession: false });
  await assert.rejects(h.api.verifyCode('first@example.test', '123456'), { uiKey: 'auth.getCodeFirst' });
  await h.api.sendCode('first@example.test');
  await assert.rejects(h.api.verifyCode('second@example.test', '123456'), { uiKey: 'auth.getCodeFirst' });
  await assert.rejects(h.api.verifyCode('first@example.test', '123456'), { uiKey: 'cloud.signInRequired' });
  assert.equal(h.calls.verifies.length, 1);
  assert.equal(await h.api.getSession(), null);
  const failed = harness({ sendResult: { error: { code: 'quota_rate_limited' } } });
  await assert.rejects(failed.api.sendCode('first@example.test'));
  await assert.rejects(failed.api.verifyCode('first@example.test', '123456'), { uiKey: 'auth.getCodeFirst' });
  assert.equal(failed.calls.verifies.length, 0);
  assert.equal(failed.api.remaining(), 0);
});

test('未登录不可读取或保存私有记录，不执行任何数据库查询', async () => {
  const h = harness();
  await assert.rejects(h.api.loadHistory(), { uiKey: 'cloud.signInRequired' });
  await assert.rejects(h.api.saveHistory({ country_code: 'DE' }), { uiKey: 'cloud.signInRequired' });
  assert.equal(h.calls.queries.length, 0);
});

test('保存仅允许字段，不传 owner_id，写后 select 读回', async () => {
  const h = harness({ session: { user: { id: 'user-1' } } });
  const saved = await h.api.saveHistory({ country_code: 'DE', purpose: 'tour', stay_days: 10, port: 'PVG', route: 'trial', code: 'A', lang: 'en', owner_id: 'attacker', email: 'private@example.test' });
  assert.equal(saved.id, 'row-1');
  const query = h.calls.queries[0];
  assert.equal(query.table, 'inbound_history');
  assert(!Object.hasOwn(query.insert, 'owner_id'));
  assert(!Object.hasOwn(query.insert, 'email'));
  assert(query.select.includes('id'));
});

test('云写入失败、空读回结果均不能假成功', async () => {
  for (const databaseResult of [{ error: { code: '42501' } }, { data: [], error: null }]) {
    const h = harness({ session: { user: { id: 'user-1' } }, databaseResult });
    await assert.rejects(h.api.saveHistory({ country_code: 'DE' }));
  }
});

test('反馈只 insert，不 select；失败拒绝且 UI 留下重试按钮', async () => {
  const h = harness({ app: true, databaseResult: { error: { code: '42501' } } });
  const wrap = h.element();
  const button = h.element();
  button.parentNode = wrap;
  wrap.setAttribute('data-answer', 'phone');
  wrap.querySelectorAll = () => [button];
  h.context.STATE.ui = { 'feedback.failed': '未提交，可重试', 'cloud.permission': '无权限' };
  await h.context.sendFeedback(button, true);
  assert.equal(h.calls.queries.length, 1);
  assert.equal(h.calls.queries[0].table, 'inbound_feedback');
  assert.equal(h.calls.queries[0].select, undefined);
  assert.equal(h.calls.queries[0].insert.answer_id, 'phone');
  assert.equal(button.disabled, false);
  assert.equal(wrap.children[0].textContent, '未提交，可重试 无权限');
  assert.equal(wrap.textContent, '');
});

test('本地预览只提示发布域名，不调用鉴权、数据库或模型', async () => {
  const h = harness({ origin: 'http://localhost:3000' });
  assert.equal(h.api.preview(), 'cloud.preview');
  await assert.rejects(h.api.getSession(), { uiKey: 'cloud.preview' });
  await assert.rejects(h.api.sendCode('traveller@example.test'), { uiKey: 'cloud.preview' });
  await assert.rejects(h.api.feedback('phone', true, 'en'), { uiKey: 'cloud.preview' });
  await assert.rejects(h.api.supplement('How do I use the metro?', 'en', new AbortController().signal, () => {}), { uiKey: 'cloud.preview' });
  assert.equal(h.calls.sends.length + h.calls.queries.length + h.calls.creates.length, 0);
});

test('LLM 使用可用模型、首条 system、stream:true，纯文本渲染且无会话记忆伪装', async () => {
  const h = harness({ app: true });
  h.context.latestQuestion = 'How do I use the metro?';
  await h.context.supplement();
  const request = h.calls.creates[0];
  assert.equal(request.model, 'usable');
  assert.equal(request.stream, true);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /绝不判断签证/);
  assert.equal(request.messages.length, 2);
  assert.equal(request.conversationId, undefined);
  const bubble = h.$('chat').children[0].children[0];
  assert.equal(bubble.children[1].textContent, '<img src=x onerror=bad()>你好世界');
  assert.equal(bubble.children[1].innerHTML, '');
});

test('模型不可用和隐私输入明确阻止请求', async () => {
  const h = harness({ models: [{ id: 'off', enabled: false }, { id: 'disabled', disabled: true }] });
  await assert.rejects(h.api.supplement('Metro help', 'en', new AbortController().signal, () => {}), { uiKey: 'ai.noModels' });
  assert.equal(h.calls.creates.length, 0);
  for (const value of ['My email is private@example.test', 'Passport: AB1234567', 'Call 13800138000']) {
    await assert.rejects(h.api.supplement(value, 'en', new AbortController().signal, () => {}), { uiKey: 'ai.privacy' });
  }
});

test('流中断保留已显示文本并标为不完整；停止信号传给 SDK', async () => {
  const h = harness({ app: true, stream: async function* () {
    yield { choices: [{ delta: { content: '保留这些文字' } }] };
    throw { error: { code: 'gateway_stream_interrupted' } };
  } });
  h.context.STATE.ui = { 'ai.incomplete': '不完整', 'cloud.network': '网络中断' };
  h.context.latestQuestion = 'Metro help';
  await h.context.supplement();
  const bubble = h.$('chat').children[0].children[0];
  assert.equal(bubble.children[1].textContent, '保留这些文字');
  assert.equal(bubble.children[2].textContent, '不完整 网络中断');
  assert(h.calls.creates[0].signal instanceof AbortSignal);
  assert.equal(h.$('aiStop').hidden, true);
});

test('停止生成保留文本且不显示完成', async () => {
  const wait = deferred();
  const h = harness({ app: true, stream: async function* (request) {
    yield { choices: [{ delta: { content: '部分内容' } }] };
    await wait.promise;
    if (request.signal.aborted) throw { uiKey: 'ai.incomplete' };
  } });
  h.context.latestQuestion = 'Metro help';
  const task = h.context.supplement();
  await new Promise(setImmediate);
  h.context.aiController.abort();
  wait.resolve();
  await task;
  assert.match(h.$('chat').children[0].children[0].children[2].textContent, /ai.incomplete/);
});

test('并发判定只渲染最新响应，只有手动保存才写云历史', async () => {
  const h = harness({ app: true });
  h.$('nat').value = 'DE';
  h.$('stay').value = '10';
  const first = deferred();
  const second = deferred();
  let requests = 0;
  const rendered = [];
  h.context.api = () => (++requests === 1 ? first.promise : second.promise);
  h.context.renderVerdict = (result) => rendered.push(result.code);
  const a = h.context.judge();
  h.$('stay').value = '20';
  const b = h.context.judge();
  second.resolve({ code: 'B' });
  await b;
  first.resolve({ code: 'A' });
  await a;
  assert.deepEqual(rendered, ['B']);
  assert.equal(h.context.latestResult.payload.stayDays, 20);
  assert.equal(h.$('saveResult').hidden, false);
  assert.equal(h.calls.queries.length, 0);
});

test('保存失败不显示成功，退出清空私有记录与对话', async () => {
  const h = harness({ app: true, session: { user: { id: 'user-1' } }, databaseResult: { error: { code: '42501' } } });
  h.context.signedInUserId = 'user-1';
  const payload = h.context.judgeInput();
  h.context.latestResult = { payload, signature: JSON.stringify(payload), result: { code: 'A' }, lang: 'en', saved: false };
  h.context.STATE.ui = { 'cloud.permission': '无权限', 'auth.signedOut': '已退出', 'history.signIn': '请登录' };
  await h.context.saveResult();
  assert.equal(h.$('saveStatus').textContent, '无权限');
  assert.equal(h.context.latestResult.saved, false);
  assert.equal(h.$('saveResult').disabled, false);
  h.$('histBox').textContent = '私有记录';
  h.$('chat').textContent = '私有对话';
  await h.context.signOut();
  assert.equal(h.$('histBox').textContent, '请登录');
  assert.equal(h.$('chat').textContent, '');
  assert.equal(h.context.signedInUserId, null);
  assert.equal(h.calls.signOut, 1);
});

test('错误分类包含权限、额度、网络、域名边界', () => {
  const h = harness();
  assert.equal(h.api.errorKey({ code: '42501' }), 'cloud.permission');
  assert.equal(h.api.errorKey({ error: { code: 'quota_exhausted' } }), 'cloud.quota');
  assert.equal(h.api.errorKey({ kind: 'network' }), 'cloud.network');
  assert.equal(h.api.errorKey({ error: { code: 'auth_origin_mismatch' } }), 'cloud.domain');
});

test('发送中禁用发送与提交，倒计时只禁用发送', async () => {
  const pending = deferred();
  const h = harness({ app: true, sendOtp: () => pending.promise });
  h.$('authEmail').value = 'traveller@example.test';
  const send = h.context.sendCode();
  assert.equal(h.$('sendCode').disabled, true);
  assert.equal(h.$('verifyCode').disabled, true);
  pending.resolve({ data: { verificationId: 'challenge-1', isExistingUser: true }, error: null });
  await send;
  assert.equal(h.$('sendCode').disabled, true);
  assert.equal(h.$('verifyCode').disabled, false);
  assert.equal(h.calls.sends.length, 1);
});

test('切换语言清对话并忽略旧问答与资格响应', async () => {
  const pendingAsk = deferred();
  const pendingJudge = deferred();
  const h = harness({ app: true });
  h.context.api = (route) => route === '/api/ask' ? pendingAsk.promise : pendingJudge.promise;
  h.context.loadAll = () => Promise.resolve();
  h.$('askin').value = 'Metro help';
  h.context.addMe = () => {};
  const answers = [];
  h.context.addBot = (answer) => answers.push(answer);
  h.context.send();
  const judging = h.context.judge();
  h.$('chat').textContent = '旧语言对话';
  h.context.setLang('ja');
  pendingAsk.resolve({ type: 'answer', item: { a: '旧回答' } });
  pendingJudge.resolve({ code: 'A' });
  await judging;
  await new Promise(setImmediate);
  assert.equal(h.$('chat').textContent, '');
  assert.equal(h.context.latestQuestion, '');
  assert.equal(h.context.latestResult, null);
  assert.equal(h.$('saveResult').hidden, true);
  assert.equal(answers.length, 0);
});

test('退出后晚到的会话恢复结果不会重新展示身份', async () => {
  const pending = deferred();
  const h = harness({ getSession: () => pending.promise });
  const sessions = [];
  h.api.subscribe((session) => sessions.push(session));
  const checking = h.api.getSession();
  await h.api.signOut();
  pending.resolve({ data: { user: { id: 'user-1' } }, error: null });
  assert.equal(await checking, null);
  assert(sessions.every((session) => session === null));
});

function response(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}
function startupResponse(url) {
  const parsed = new URL(url, 'https://app.example');
  const lang = parsed.searchParams.get('lang') || 'en';
  const fixtures = {
    '/api/ui': { lang, ui: { 'ui.serviceUnavailable': lang + '：服务暂不可用', 'ui.retry': lang + '：重试',
      'ui.status.loading': lang + '：正在加载', 'ui.status.connected': lang + '：已连接 {version}',
      'live.cached': '旧缓存', 'policy.sources': '资料来源' } },
    '/api/languages': { items: [{ code: lang, native: lang }] },
    '/api/meta': { policy: { version: 'fixture' } },
    '/api/countries': { items: [{ code: 'DE', name: 'fixture' }] },
    '/api/destinations': { categories: [], items: [{ id: 'test', title: 'fixture', desc: '', badges: [], booking: {} }] },
    '/api/questions': { items: [] }, '/api/policy': { stats: [], steps: [], notes: [] },
    '/api/policy/health': { status: 'review', version: 'fixture', rules: [] },
    '/api/health': { storage: {} },
    '/api/live': { weather: { ok: true, stale: false, items: [{ id: 'test', temp: 18, cat: 'clear' }] }, fx: { ok: true, rates: {} } }
  };
  assert(Object.hasOwn(fixtures, parsed.pathname), '未预期的离线请求：' + url);
  return response(fixtures[parsed.pathname]);
}
function startupHarness(options = {}) {
  const h = harness({ app: true, fetch: startupResponse, ...options });
  h.context.judge = () => Promise.resolve();
  h.context.tax = () => Promise.resolve();
  return h;
}

for (const lang of ['en', 'zh', 'ja', 'ko', 'es', 'ru']) {
  test(`启动全断网 ${lang}：无界面包仍显示明文和可见重试，不泄露异常`, async () => {
    const h = startupHarness({ fetch: async () => { throw new Error('secret-upstream-details'); } });
    h.context.STATE.lang = lang;
    await h.context.loadAll();
    assert.equal(h.context.STATE.loadState, 'failed');
    assert.equal(h.context.STATE.bound, undefined);
    assert.equal(h.$('loadNotice').hidden, false);
    assert.equal(h.$('retryLoad').hidden, false);
    assert.equal(h.$('retryLoad').textContent, h.context.BOOT_COPY[lang].retry);
    assert.equal(h.$('apiStatus').textContent, h.context.BOOT_COPY[lang].failed);
    assert.doesNotMatch(h.$('loadMessage').textContent, /⟦|secret-upstream-details/);
  });
}

test('界面包独立成功即可赋值；其他 API 先失败也用当前语言明文而不是旧字典', async () => {
  const ui = deferred();
  const h = startupHarness({ fetch: (url) => url.startsWith('/api/ui?') ? ui.promise : Promise.reject(new Error('secret')) });
  h.context.STATE.lang = 'ja';
  h.context.STATE.ui = { 'ui.serviceUnavailable': '旧语言' };
  const loading = h.context.loadAll();
  assert.deepEqual(Object.keys(h.context.STATE.ui), []);
  await new Promise(setImmediate);
  ui.resolve(startupResponse('/api/ui?lang=ja'));
  await loading;
  assert.equal(h.context.STATE.uiLang, 'ja');
  assert.equal(h.$('loadMessage').textContent, 'ja：服务暂不可用');
  assert.equal(h.$('retryLoad').textContent, 'ja：重试');
  assert.equal(h.context.STATE.data.dest, null);
});

test('其他启动接口尚在等待时，当前界面包已独立赋值且更新加载提示', async () => {
  const pending = deferred();
  const h = startupHarness({ fetch: (url) => url.startsWith('/api/meta?') ? pending.promise : Promise.resolve(startupResponse(url)) });
  const loading = h.context.loadAll();
  await new Promise(setImmediate);
  assert.equal(h.context.STATE.uiLang, 'en');
  assert.equal(h.context.STATE.loadState, 'loading');
  assert.equal(h.$('loadMessage').textContent, 'en：正在加载');
  pending.resolve(startupResponse('/api/meta?lang=en'));
  await loading;
  assert.equal(h.context.STATE.loadState, 'ready');
  await h.context.liveFlight.promise;
});

test('HTTP 5xx 即使 JSON 外形正常也失败，不读取错误正文', async () => {
  for (const route of ['/api/ui', '/api/languages', '/api/meta']) {
    const h = startupHarness({ fetch: async (url) => url.split('?')[0] === route ? {
      ok: false, status: 503, json() { throw new Error('不应读取错误响应'); }
    } : Promise.resolve(startupResponse(url)) });
    await h.context.loadAll();
    assert.equal(h.context.STATE.loadState, 'failed');
    assert.doesNotMatch(h.$('apiStatus').textContent, /⟦|不应读取/);
  }
});

test('首屏尚未绑定业务事件即可点击重试，恢复后清除错误并正常绑定', async () => {
  let offline = true;
  const h = startupHarness({ fetch: async (url) => { if (offline) throw new Error('offline'); return startupResponse(url); } });
  h.context.boot();
  await new Promise(setImmediate);
  assert.equal(h.context.STATE.loadState, 'failed');
  assert.equal(h.context.STATE.bound, undefined);
  offline = false;
  h.$('retryLoad').fire('click');
  assert.equal(h.$('retryLoad').hidden, true);
  await new Promise(setImmediate);
  assert.equal(h.context.STATE.loadState, 'ready');
  assert.equal(h.$('loadNotice').hidden, true);
  assert.equal(h.$('loadMessage').textContent, '');
  assert.equal(h.context.STATE.bound, true);
  assert.match(h.$('apiStatus').textContent, /已连接/);
});

test('非法保存语言和非法 setLang 不进入请求，URL 与浏览器语言保持白名单', async () => {
  for (const savedLang of ['xx', '__proto__', 'constructor', 'EN']) {
    const requested = [];
    const h = startupHarness({ savedLang, browserLang: 'ko-KR', search: '?lang=invalid', fetch: async (url) => { requested.push(url); return startupResponse(url); } });
    h.context.boot();
    await new Promise(setImmediate);
    assert.equal(h.context.STATE.lang, 'ko');
    const sequence = h.context.loadSequence;
    h.context.setLang(savedLang);
    assert.equal(h.context.STATE.lang, 'ko');
    assert.equal(h.context.loadSequence, sequence);
    assert(requested.every((url) => new URL(url, 'https://app.example').searchParams.get('lang') === 'ko'));
  }
});

test('五分钟定时器真实请求实时资料，隐藏页不轮询，刷新并发复用且健康面板立即更新', async () => {
  const requested = [];
  let pending = null;
  const h = startupHarness({ fetch: (url) => {
    requested.push(url);
    if (pending && url.startsWith('/api/live?')) return pending.promise;
    return Promise.resolve(startupResponse(url));
  } });
  h.context.boot();
  await new Promise(setImmediate);
  const tick = h.intervals.find((item) => item.delay === 300000);
  assert(tick);
  const before = requested.filter((url) => url.startsWith('/api/live?')).length;
  h.context.document.hidden = true;
  tick.callback();
  await new Promise(setImmediate);
  assert.equal(requested.filter((url) => url.startsWith('/api/live?')).length, before);
  h.context.document.hidden = false;
  pending = deferred();
  const panels = [];
  h.context.renderLivePanel = () => panels.push(h.context.STATE.data.policyHealth.version);
  tick.callback();
  tick.callback();
  assert.equal(requested.filter((url) => url.startsWith('/api/live?')).length, before + 1);
  await new Promise(setImmediate);
  assert.deepEqual(panels, ['fixture']);
  pending.resolve(startupResponse('/api/live?lang=en'));
  await h.context.liveFlight.promise;
  assert.equal(h.context.STATE.data.dest.items[0].weather.temp, 18);
});

test('实时刷新失败保留旧天气并明确标 stale，不把缓存显示为实时', async () => {
  let failLive = false;
  const h = startupHarness({ fetch: async (url) => {
    if (failLive && url.startsWith('/api/live?')) throw new Error('offline');
    return startupResponse(url);
  } });
  await h.context.loadAll();
  await h.context.liveFlight.promise;
  failLive = true;
  await h.context.refreshLive();
  assert.equal(h.context.STATE.data.dest.items[0].weather.temp, 18);
  assert.equal(h.context.STATE.data.dest.live.stale, true);
  assert.equal(h.context.STATE.data.live.fx.ok, false);
  assert.match(h.$('destList').innerHTML, /旧缓存/);
});

test('旧启动与旧界面响应不能覆盖新语言；切换失败时不展示旧业务结果', async () => {
  const old = deferred();
  let fail = false;
  const h = startupHarness({ fetch: (url) => {
    if (url.includes('lang=en')) return old.promise.then(() => startupResponse(url));
    if (fail && url.startsWith('/api/meta?')) return Promise.reject(new Error('offline'));
    return Promise.resolve(startupResponse(url));
  } });
  const first = h.context.loadAll();
  h.context.setLang('ja');
  await new Promise(setImmediate);
  assert.equal(h.context.STATE.uiLang, 'ja');
  old.resolve();
  await first;
  assert.equal(h.context.STATE.lang, 'ja');
  assert.equal(h.context.STATE.uiLang, 'ja');
  fail = true;
  h.context.setLang('es');
  assert.equal(h.context.STATE.data.dest, null);
  await new Promise(setImmediate);
  assert.equal(h.context.STATE.loadState, 'failed');
  assert.equal(h.context.STATE.data.dest, null);
  assert.equal(h.$('loadMessage').textContent, 'es：服务暂不可用');
});

test('旧实时刷新不能覆盖新 loadAll，且新一轮不被旧在途请求阻塞', async () => {
  const old = deferred();
  let block = false;
  const h = startupHarness({ fetch: (url) => block && url.startsWith('/api/live?') ? old.promise : Promise.resolve(startupResponse(url)) });
  await h.context.loadAll();
  await h.context.liveFlight.promise;
  block = true;
  const previous = h.context.refreshLive();
  block = false;
  await h.context.loadAll();
  await h.context.liveFlight.promise;
  old.resolve(response({ weather: { items: [{ id: 'test', temp: 99 }] } }));
  await previous;
  assert.equal(h.context.STATE.data.dest.items[0].weather.temp, 18);
});

test('金额空值省略 amount，零金额保留 0；blocked 展示本地化提示与安全来源', async () => {
  const requests = [];
  const h = harness({ app: true, fetch: async (url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ blocked: true, sources: [
      { url: 'https://sources.example/document', document: '<资料>' },
      { url: 'javascript:alert(1)' }, { url: 'https://user:secret@sources.example/' }
    ] });
  } });
  h.context.STATE.ui = { 'ui.serviceUnavailable': '服务暂不可用', 'policy.sources': '资料来源' };
  h.$('shopDate').value = '2026-11-01';
  h.$('taxRoute').value = 'port';
  h.$('curSel').value = 'USD';
  await h.context.tax();
  h.$('shopAmt').value = '0';
  await h.context.tax();
  assert(!Object.hasOwn(requests[0], 'amount'));
  assert.equal(requests[1].amount, 0);
  assert.match(h.$('taxRes').innerHTML, /服务暂不可用/);
  assert.match(h.$('taxRes').innerHTML, /href="https:\/\/sources.example\/document"/);
  assert.match(h.$('taxRes').innerHTML, /&lt;资料&gt;/);
  assert.doesNotMatch(h.$('taxRes').innerHTML, /javascript:|user:secret/);
});

test('旅行灵感卡使用本地图、保留天气时效且不将未核实预约标为可购买', () => {
  const h = harness({ app: true });
  h.context.STATE.ui = { 'home.view': '查看路线', 'ui.booking.unverified': '待核实', 'wx.clear': '晴', 'live.cached': '旧缓存', 'wx.offline': '暂不可用' };
  h.context.STATE.data.dest = { live: { stale: true }, items: [{ id: 'heritage-axis', cat: 'his', title: '<长城>', desc: '<旅行>', badges: ['<标签>'], weather: { temp: 20, cat: 'clear' }, booking: { verified: false, passportOnline: 'yes' } }] };
  h.context.renderDest('all');
  const html = h.$('destList').innerHTML;
  assert.match(html, /src="assets\/heritage-axis.jpg"/);
  assert.match(html, /data-act="openDest" data-id="heritage-axis"/);
  assert.match(html, /&lt;长城&gt;/);
  assert.match(html, /旧缓存/);
  assert.match(html, /待核实/);
  assert.doesNotMatch(html, /passportOnline|data-act="buy"/);
  h.context.renderDest('nat');
  assert.equal(h.$('destList').innerHTML, '');
  assert.equal(h.context.destArt('__proto__'), 'assets/heritage-axis.jpg');
});

test('主题详情可打开返回、准备及预填问题，不自动发送问题或写入云端', () => {
  const h = harness({ app: true });
  h.$('routeDetail').hidden = true;
  h.context.STATE.greeted = true;
  h.context.STATE.data.dest = { items: [{ id: 'food-trail', title: '美食之旅', desc: '旅行说明', badges: ['美食'] }], disclaimer: '灵感不是商品' };
  let focused = 0;
  h.$('detailBack').focus = () => { focused++; };
  const trigger = { isConnected: true, focus() { focused++; } };
  h.context.openDest('missing', trigger);
  assert.equal(h.$('routeDetail').hidden, true);
  h.context.openDest('food-trail', trigger);
  assert.equal(h.$('routeDetail').hidden, false);
  assert.equal(h.$('detailTitle').textContent, '美食之旅');
  assert.equal(h.$('detailImage').attributes.src, 'assets/food-trail.jpg');
  assert.equal(h.$('views').attributes.inert, '');
  assert.equal(h.$('detailNotice').textContent, '灵感不是商品');
  h.context.closeDest();
  assert.equal(focused, 2);
  assert.equal(h.$('views').attributes.inert, undefined);
  assert.equal(h.$('routeDetail').hidden, true);
  h.context.openDest('food-trail', trigger);
  h.context.detailAsk();
  assert.equal(h.$('askin').value, '美食之旅');
  assert.equal(h.context.STATE.selectedDest, null);
  assert.equal(h.calls.queries.length + h.calls.creates.length, 0);
});

test('本地样式脚本相对入口加载、六张插画存在且不再有假手机状态栏', () => {
  const root = path.join(__dirname, '../public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /href="styles.css\?v=/);
  assert.doesNotMatch(html, /(?:src|href)="\/(?:app\.js|styles\.css|cloud(?:-config)?\.js)/);
  assert.doesNotMatch(html, /9:41|5G/);
  assert.equal((html.match(/id="langSel"/g) || []).length, 1);
  assert.match(html, /id="routeDetail"[^>]*hidden/);
  for (const name of ['heritage-axis', 'heritage-gardens', 'nature-southwest', 'city-skylines', 'food-trail', 'seasonal']) {
    const image = fs.readFileSync(path.join(root, 'assets', name + '.jpg'));
    assert(image.length > 10000, name + ' 缺少实际配图');
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
  }
});

test('HTML 脚本顺序、默认隐藏评审面板、无内联事件与旧匿名记录 API', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 4);
  assert(scripts.every((attrs) => /\bdefer\b/.test(attrs) && /\bsrc=/.test(attrs)));
  assert.match(scripts[0], /workbuddy-cloud-sdk@dev\/lib\/index.global.js/);
  assert.match(scripts[1], /cloud-config.js/);
  assert.match(scripts[2], /cloud.js/);
  assert.match(scripts[3], /app.js/);
  assert.match(html, /<aside[^>]*\bid="notes"[^>]*\bhidden/);
  assert.doesNotMatch(html, /\son\w+\s*=/);
  assert.doesNotMatch(appSource, /anonSid|\/api\/history|\/api\/feedback|inbound\.sid/);
});
