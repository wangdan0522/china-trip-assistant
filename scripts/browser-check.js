'use strict';

// 离线界面验收：天气、汇率使用固定数据；真实云 SDK 仍直接由浏览器从 CDN 加载。
// 本脚本不验证上游联网或云登录，不替换 Origin、用户身份、SDK 或云会话。
// 用法：node scripts/browser-check.js [--screenshot=/绝对路径/截图.png]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
const LANGUAGES = ['en', 'zh', 'ja', 'ko', 'es', 'ru'];
const VIEWS = ['exp', 'ask', 'prep', 'arr', 'dep'];
const WAIT_MS = 15000;
const INTERACTION_CHECKS = [
  '资格 DE 选择并提交后显示真实后端结果',
  '资格 US 切换提交清除旧结果并显示新结果',
  '普通口岸 90 天与 10000 元对应 800–1100 范围',
  '即买即退无协议日不编造日期且无绿色 res.A',
  '即买即退严格使用输入的实际协议截止日',
  '切语言清除旧对话、旧资格结论与旧退税结果',
  '本机云通知明确不可用且没有云登录成功'
];
const PLANNED_CHECKS = [
  ...LANGUAGES.flatMap((lang) => [
    `${lang} loadAll 首屏与翻译键`, `${lang} live 异步数据`, `${lang} 五个 tab 真实点击`,
    ...[375, 320].map((width) => `${lang} ${width}px 五个视图 body 无横向溢出`)
  ]),
  ...INTERACTION_CHECKS
];

function ensure(value, message) {
  if (!value) throw new Error(message);
}

function connectCDP(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const pending = new Map();
    const listeners = new Set();
    let sequence = 0;
    let opened = false;
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP WebSocket 连接超过 15 秒')); }, WAIT_MS);
    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((done, fail) => {
            const id = ++sequence;
            const timeout = setTimeout(() => {
              pending.delete(id);
              fail(new Error(`CDP ${method} 超过 20 秒`));
            }, WAIT_MS + 5000);
            pending.set(id, { done, fail, timeout });
            try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
            catch (error) { clearTimeout(timeout); pending.delete(id); fail(error); }
          });
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        close() { socket.close(); }
      });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timeout);
        pending.delete(message.id);
        if (message.error) item.fail(new Error(JSON.stringify(message.error)));
        else item.done(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
    socket.addEventListener('error', () => {
      if (!opened) { clearTimeout(timer); reject(new Error('CDP WebSocket 无法连接')); }
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      if (!opened) reject(new Error('CDP WebSocket 在连接完成前关闭'));
      for (const item of pending.values()) { clearTimeout(item.timeout); item.fail(new Error('CDP 连接已关闭')); }
      pending.clear();
    });
  });
}

function launchChrome(profile, report) {
  const child = spawn(CHROME, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ error: error.message }));
  });
  let stderr = '';
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome 未在 15 秒内开放 CDP；${stderr.slice(-3000)}`)), WAIT_MS);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
      const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`Chrome 启动失败：${error.message}`)); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 在 CDP 就绪前退出：code=${code}, signal=${signal}；${stderr.slice(-3000)}`));
    });
  });
  report.chromeExecutable = CHROME;
  return { child, exited, endpoint, stderr: () => stderr };
}

async function terminateChrome(chrome) {
  if (!chrome || chrome.child.exitCode !== null || chrome.child.signalCode !== null) return;
  if (!chrome.child.pid) return;
  chrome.child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([
    chrome.exited,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); })
  ]);
  clearTimeout(timer);
  if (!result) {
    chrome.child.kill('SIGKILL');
    await chrome.exited;
  }
}

async function runBrowserCheck(args = []) {
  const screenshotArg = args.find((value) => value.startsWith('--screenshot='));
  const unknown = args.filter((value) => !value.startsWith('--screenshot='));
  ensure(!unknown.length, `未知参数：${unknown.join(', ')}`);
  ensure(args.filter((value) => value.startsWith('--screenshot=')).length <= 1, '只能指定一个截图路径');
  const screenshot = screenshotArg ? path.resolve(screenshotArg.slice('--screenshot='.length)) : null;
  if (screenshotArg) {
    ensure(screenshotArg.slice('--screenshot='.length), '截图路径不能为空');
    ensure(fs.statSync(path.dirname(screenshot)).isDirectory(), '截图父目录必须已存在');
    ensure(!fs.existsSync(screenshot), '截图目标已存在，拒绝覆盖');
  }
  fs.accessSync(CHROME, fs.constants.X_OK);
  ensure(typeof WebSocket === 'function', '需要提供全局 WebSocket 的 Node v22');
  for (const name of ['../server/index', '../server/store', '../server/live', '../server/policy-registry']) {
    ensure(!require.cache[require.resolve(name)], '请在独立 Node 进程中运行，业务模块不得提前加载');
  }

  const report = {
    mode: '离线界面验收；天气与汇率为测试数据，上游监测不可用；不代表联网或云登录验收',
    sdk: { url: SDK_URL, observations: [], requests: [] },
    checks: [], diagnostics: { exceptions: [], consoleErrors: [], browserErrors: [], consoleWarnings: [], cspErrors: [], networkFailures: [] },
    cleanupErrors: []
  };
  const ownedDirectories = [];
  const previousEnv = new Map();
  let server;
  let chrome;
  let cdp;
  let store;
  let live;
  let sessionId;
  let origin;
  let diagnosticsReady = false;
  let navigationAttempted = false;
  const setEnv = (name, value) => {
    previousEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      report.checks.push({ name, status: 'passed', ...(detail === undefined ? {} : { detail }) });
      console.log(`通过 ${name}`);
      return true;
    } catch (error) {
      report.checks.push({ name, status: 'failed', error: error.message });
      console.error(`失败 ${name}：${error.message}`);
      return false;
    }
  };
  const skip = (name, reason) => report.checks.push({ name, status: 'skipped', reason });
  const command = (method, params) => cdp.send(method, params, sessionId);
  const navigate = async (url) => {
    let timer;
    let unsubscribe;
    const loaded = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('页面 DOMContentLoaded 超过 15 秒；请检查真实 CDN SDK 的网络诊断')), WAIT_MS);
      unsubscribe = cdp.onEvent((event) => {
        if (event.sessionId === sessionId && event.method === 'Page.domContentEventFired') resolve();
      });
    });
    try {
      const [result] = await Promise.all([command('Page.navigate', { url }), loaded]);
      ensure(!result.errorText, `页面导航失败：${result.errorText}`);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  };
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = (predicate, label) => evaluate(`(() => new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let interval;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener('DOMContentLoaded', inspect);
      if (error) reject(error); else resolve(true);
    };
    const inspect = () => { try { if (${predicate}) finish(); } catch (_) {} };
    timer = setTimeout(() => finish(new Error(${JSON.stringify(`${label}：15 秒内条件未满足`)})), 15000);
    interval = setInterval(inspect, 50);
    document.addEventListener('DOMContentLoaded', inspect);
    inspect();
  }))()`);
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled || !node.getClientRects().length) throw new Error('按钮不可见或禁用：' + ${JSON.stringify(selector)});
      node.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      const rect = node.getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const field = (id, value, type = 'change') => evaluate(`(() => {
    const node = document.getElementById(${JSON.stringify(id)});
    if (!node) throw new Error('缺少字段：' + ${JSON.stringify(id)});
    node.value = ${JSON.stringify(value)};
    if (node.value !== ${JSON.stringify(value)}) throw new Error('字段不接受输入：' + ${JSON.stringify(id)});
    node.dispatchEvent(new Event(${JSON.stringify(type)}, {bubbles: true}));
    return node.value;
  })()`);
  const view = async (name) => {
    await click(`.tabs button[data-v="${name}"]`);
    await waitFor(`document.querySelector('#v-${name}.on') && STATE.view === '${name}' && document.querySelector('.tabs button[data-v="${name}"].on')`, `切换 tab ${name}`);
  };
  const submitJudgement = async () => {
    const form = await evaluate(`(() => {
      const wrap = document.getElementById('judgeWrap');
      const form = wrap.closest('form') || wrap.querySelector('form');
      if (!form) return null;
      const button = form.querySelector('button[type="submit"],input[type="submit"]');
      if (button) { button.setAttribute('data-browser-check-submit', ''); return 'button'; }
      form.requestSubmit();
      return 'form';
    })()`);
    if (form === 'button') await click('[data-browser-check-submit]');
    return form ? '原生表单 submit' : '现有字段 change/input 自动提交';
  };
  const noMissingKeys = async () => {
    const missing = await evaluate(`(() => {
      const text = document.body.textContent + '\\n' + document.title + '\\n' + Array.from(document.querySelectorAll('[placeholder],[title],[aria-label]')).map(n => [n.getAttribute('placeholder'), n.getAttribute('title'), n.getAttribute('aria-label')].join(' ')).join('\\n');
      return Array.from(new Set(text.match(/⟦[^⟧]*⟧/g) || []));
    })()`);
    ensure(!missing.length, `存在未翻译键：${missing.join(', ')}`);
  };
  const requests = new Map();
  const captureBody = async (pattern, after) => {
    await waitFor(`performance.getEntriesByType('resource').filter(e => e.name.includes(${JSON.stringify(pattern)})).length > ${after}`, `等待 ${pattern} 响应`);
    return evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes(${JSON.stringify(pattern)})).length`);
  };
  const countResource = (name) => evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes(${JSON.stringify(name)})).length`);
  const taxResponse = async (after) => {
    await captureBody('/api/taxfree', after);
    await waitFor(`!!document.querySelector('#taxRes .res')`, '退税结果显示');
    const candidates = [...requests.entries()].filter(([, item]) => item.url.startsWith(origin + '/api/taxfree') && item.finished);
    const latest = candidates[candidates.length - 1];
    ensure(latest, 'CDP 没有收到已完成的退税响应');
    const body = await command('Network.getResponseBody', { requestId: latest[0] });
    return JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
  };

  console.log(report.mode);
  try {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-browser-profile-'));
    ownedDirectories.push(profile);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-browser-data-'));
    ownedDirectories.push(data);
    setEnv('INBOUND_DATA_DIR', data);
    for (const [name, file] of Object.entries({
      INBOUND_DB_FILE: 'inbound.db', INBOUND_FEEDBACK_FILE: 'feedback.jsonl', INBOUND_HISTORY_FILE: 'history.jsonl',
      INBOUND_AUDIT_FILE: 'policy-audit.jsonl', LIVE_STATE_FILE: 'live-state.json', INBOUND_REGISTRY_FILE: 'registry.json'
    })) setEnv(name, path.join(data, file));
    fs.copyFileSync(path.join(__dirname, '..', 'data', 'policy-registry.json'), path.join(data, 'registry.json'));
    setEnv('INBOUND_STORAGE_MODE', '');
    setEnv('POLICY_ADMIN_TOKEN', undefined);
    setEnv('QUIET', '1');
    setEnv('TRUST_PROXY', '0');
    live = require('../server/live');
    store = require('../server/store');
    live.configure({ fetch: async (url) => {
      const host = new URL(String(url)).hostname;
      const now = new Date();
      const json = (body) => ({ ok: true, status: 200, json: async () => body });
      if (host === 'api.met.no') return json({ properties: { timeseries: [{
        time: now.toISOString(), data: {
          instant: { details: { air_temperature: 18, relative_humidity: 55, wind_speed: 2 } },
          next_1_hours: { summary: { symbol_code: 'partlycloudy_day' } }
        }
      }] } });
      if (host === 'open.er-api.com') return json({
        result: 'success', base_code: 'CNY', time_last_update_utc: now.toUTCString(),
        rates: { CNY: 1, USD: 0.14, EUR: 0.13, GBP: 0.11, JPY: 21, KRW: 190, RUB: 12, AUD: 0.21, CAD: 0.19, SGD: 0.18, HKD: 1.09, THB: 4.8, MYR: 0.62 }
      });
      throw new Error(`离线界面验收未连接此上游：${host}`);
    } });
    server = require('../server/index').createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    report.origin = origin;
    chrome = launchChrome(profile, report);
    cdp = await connectCDP(await chrome.endpoint);
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;
    cdp.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      const p = event.params || {};
      if (event.method === 'Runtime.exceptionThrown') {
        const detail = p.exceptionDetails;
        report.diagnostics.exceptions.push(detail.exception?.description || `${detail.text} ${detail.url || ''}:${detail.lineNumber}`);
      }
      if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(p.type)) {
        const text = (p.args || []).map((item) => item.description || String(item.value)).join(' ');
        report.diagnostics[p.type === 'error' ? 'consoleErrors' : 'consoleWarnings'].push(text);
      }
      if (event.method === 'Log.entryAdded') {
        const item = p.entry;
        if (item.level === 'error') report.diagnostics.browserErrors.push({ source: item.source, text: item.text, url: item.url });
        if (item.source === 'security' || /Content Security Policy|violates.*directive|Refused to (load|execute|connect)/i.test(item.text)) {
          if (item.level === 'error' || /Content Security Policy|violates.*directive/i.test(item.text)) {
            report.diagnostics.cspErrors.push({ text: item.text, url: item.url });
          }
        }
      }
      if (event.method === 'Network.requestWillBeSent') {
        requests.set(p.requestId, { url: p.request.url, method: p.request.method, postData: p.request.postData });
      }
      if (event.method === 'Network.responseReceived') {
        const item = requests.get(p.requestId);
        if (item) Object.assign(item, { status: p.response.status, mimeType: p.response.mimeType, url: p.response.url });
      }
      if (event.method === 'Network.loadingFinished') {
        const item = requests.get(p.requestId);
        if (item) item.finished = true;
      }
      if (event.method === 'Network.loadingFailed') {
        const item = requests.get(p.requestId);
        if (item) Object.assign(item, { error: p.errorText, blockedReason: p.blockedReason });
        report.diagnostics.networkFailures.push({ url: item?.url, error: p.errorText, blockedReason: p.blockedReason, canceled: p.canceled });
      }
    });
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Log.enable');
    await command('Network.enable');
    diagnosticsReady = true;
    const browser = await cdp.send('Browser.getVersion');
    report.browserVersion = browser.product;
    let currentReady = false;
    for (const lang of LANGUAGES) {
      currentReady = await check(`${lang} loadAll 首屏与翻译键`, async () => {
        await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        navigationAttempted = true;
        await navigate(`${origin}/?lang=${lang}`);
        await waitFor(`typeof STATE !== 'undefined' && STATE.bound && STATE.lang === '${lang}' && STATE.data.dest && STATE.data.dest.items.length > 0 && document.documentElement.lang === '${lang}' && document.querySelector('#destList .exp')`, `${lang} loadAll 首屏`);
        await noMissingKeys();
        const data = await evaluate(`({ countries: STATE.data.countries.length, questions: STATE.data.questions.length, status: document.getElementById('apiStatus').textContent, sdk: !!(window.WorkBuddyCloud && typeof WorkBuddyCloud.createWorkBuddyCloud === 'function') })`);
        report.sdk.observations.push({ lang, available: data.sdk });
        ensure(data.countries > 0 && data.questions > 0, `loadAll 首屏数据未就绪：${JSON.stringify(data)}`);
        return data;
      });
      if (currentReady) {
        await check(`${lang} live 异步数据`, async () => {
          await waitFor(`STATE.data.live && STATE.data.live.weather && STATE.data.live.weather.ok && STATE.data.live.fx && STATE.data.live.fx.ok`, `${lang} 独立异步 live 数据`);
          return evaluate(`({ weather: STATE.data.live.weather.ok, fx: STATE.data.live.fx.ok })`);
        });
      } else skip(`${lang} live 异步数据`, 'loadAll 首屏未就绪');
      if (!currentReady) {
        try {
          report.sdk.observations.push({ lang, available: await evaluate(`!!(window.WorkBuddyCloud && typeof WorkBuddyCloud.createWorkBuddyCloud === 'function')`) });
        } catch (error) { report.sdk.observations.push({ lang, available: false, error: error.message }); }
      }
      if (currentReady) {
        await check(`${lang} 五个 tab 真实点击`, async () => {
          for (const name of VIEWS) await view(name);
          return VIEWS;
        });
      } else skip(`${lang} 五个 tab 真实点击`, 'loadAll 首屏未就绪');
      for (const width of [375, 320]) {
        const name = `${lang} ${width}px 五个视图 body 无横向溢出`;
        if (!currentReady) { skip(name, 'loadAll 首屏未就绪'); continue; }
        await check(name, async () => {
          await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
          const measurements = [];
          for (const name of VIEWS) {
            await view(name);
            await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
            const size = await evaluate(`({ viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth, offenders: Array.from(document.body.querySelectorAll('*')).filter(n => n.getClientRects().length && getComputedStyle(n).position !== 'fixed' && n.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(n => ({tag:n.tagName, id:n.id, className:String(n.className), right:n.getBoundingClientRect().right})) })`);
            measurements.push({ view: name, ...size });
          }
          const overflow = measurements.filter((row) => row.viewport !== width || row.body > width + 1 || row.document > width + 1);
          ensure(!overflow.length, JSON.stringify(overflow));
          return measurements.map(({ view, viewport, body, document }) => ({ view, viewport, body, document }));
        });
      }
    }

    const interaction = async (name, fn) => {
      if (!currentReady) { skip(name, '最终语言首屏未就绪'); return; }
      return check(name, fn);
    };
    await interaction('资格 DE 选择并提交后显示真实后端结果', async () => {
      await command('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await view('exp');
      await click('[data-act="toJudge"]');
      await waitFor(`STATE.view === 'ask' && document.getElementById('judgeWrap').style.display !== 'none'`, '资格表单显示');
      await field('nat', 'DE');
      await field('ppt', 'ord');
      await field('pur', 'tour');
      await field('stay', '10', 'input');
      await field('inp', 'PVG');
      await field('nxt', 'home');
      const submission = await submitJudgement();
      await waitFor(`latestResult && latestResult.payload.countryCode === 'DE' && document.querySelector('#res .res') && document.querySelector('#res .big').textContent.trim()`, 'DE 资格结果');
      await noMissingKeys();
      return evaluate(`({country: latestResult.payload.countryCode, code: latestResult.result.code, title: document.querySelector('#res .big').textContent, submission: ${JSON.stringify(submission)} })`);
    });
    await interaction('资格 US 切换提交清除旧结果并显示新结果', async () => {
      await view('ask');
      const cleared = await evaluate(`(() => {
        const selector = document.getElementById('nat');
        selector.value = 'US';
        selector.dispatchEvent(new Event('change', {bubbles: true}));
        return selector.value === 'US' && !latestResult && document.getElementById('res').textContent === '';
      })()`);
      ensure(cleared, '国籍更改后旧资格结果未同步清除');
      await submitJudgement();
      await waitFor(`latestResult && latestResult.payload.countryCode === 'US' && document.querySelector('#res .res')`, 'US 资格结果');
      await noMissingKeys();
      return evaluate(`({country: latestResult.payload.countryCode, code: latestResult.result.code, title: document.querySelector('#res .big').textContent})`);
    });
    let shoppingDate;
    let suppliedDeadline;
    await interaction('普通口岸 90 天与 10000 元对应 800–1100 范围', async () => {
      await view('dep');
      shoppingDate = await evaluate(`document.getElementById('shopDate').value`);
      suppliedDeadline = new Date(Date.parse(shoppingDate + 'T00:00:00Z') + 17 * 86400000).toISOString().slice(0, 10);
      const count = await countResource('/api/taxfree');
      await field('taxRoute', 'port');
      await field('shopAmt', '10000', 'input');
      await field('curSel', 'USD');
      const result = await taxResponse(count);
      const expected = new Date(Date.parse(shoppingDate + 'T00:00:00Z') + 90 * 86400000).toISOString().slice(0, 10);
      ensure(result.route === 'port' && result.deadline === expected && result.windowDays === 90, `口岸期限错误：${JSON.stringify(result)}`);
      ensure(result.estimate?.grossMinCNY === 800 && result.estimate.grossMaxCNY === 1100 && result.estimate.feeKnown === false, `参考范围错误：${JSON.stringify(result.estimate)}`);
      const text = await evaluate(`document.getElementById('taxRes').textContent`);
      const visibleRange = await evaluate(`document.getElementById('taxRes').textContent.includes('¥' + fmtNum(800) + '–¥' + fmtNum(1100))`);
      ensure(visibleRange, `页面没有渲染 800–1100 范围：${text}`);
      ensure(await evaluate(`document.querySelector('#taxRes .big').textContent.includes(fmtDate(${JSON.stringify(expected)}))`), '页面没有显示 90 天截止日期');
      await noMissingKeys();
      return { shoppingDate, deadline: result.deadline, min: 800, max: 1100, feeKnown: false };
    });
    await interaction('即买即退无协议日不编造日期且无绿色 res.A', async () => {
      await view('dep');
      const count = await countResource('/api/taxfree');
      await field('agreementDeadline', '');
      await field('taxRoute', 'instant');
      const result = await taxResponse(count);
      ensure(result.route === 'instant' && result.status === 'needs_agreement' && result.deadline === null, `无协议日返回了期限：${JSON.stringify(result)}`);
      const rendered = await evaluate(`({ green: !!document.querySelector('#taxRes .res.A'), heading: document.querySelector('#taxRes .big').textContent, expected: t('ui.tax.needsAgreement'), values: Array.from(document.querySelectorAll('#taxRes .rows .row .v')).map(n => n.textContent), agreementShown: !document.getElementById('agreementField').hidden })`);
      ensure(!rendered.green && rendered.agreementShown && rendered.heading === rendered.expected && rendered.values[1] === '—', `无协议日界面错误：${JSON.stringify(rendered)}`);
      await noMissingKeys();
      return { status: result.status, deadline: result.deadline, ...rendered };
    });
    await interaction('即买即退严格使用输入的实际协议截止日', async () => {
      ensure(suppliedDeadline, '普通口岸场景未生成购物日');
      const count = await countResource('/api/taxfree');
      await field('agreementDeadline', suppliedDeadline);
      const result = await taxResponse(count);
      ensure(result.route === 'instant' && result.deadline === suppliedDeadline && result.deadlineBasis === 'user_supplied_agreement', `未按输入协议日提醒：${JSON.stringify(result)}`);
      ensure(await evaluate(`!document.querySelector('#taxRes .res.A') && document.querySelector('#taxRes .big').textContent.includes(fmtDate(${JSON.stringify(suppliedDeadline)}))`), '协议日未正确渲染或被渲染为绿色资格成功');
      await noMissingKeys();
      return { suppliedDeadline, returnedDeadline: result.deadline, basis: result.deadlineBasis };
    });
    await interaction('切语言清除旧对话、旧资格结论与旧退税结果', async () => {
      await view('ask');
      const firstQuestion = await evaluate(`document.querySelector('#qk button')?.getAttribute('data-qid')`);
      ensure(firstQuestion, '没有可点击的真实问答问题');
      await click(`#qk button[data-qid="${firstQuestion}"]`);
      await waitFor(`document.querySelector('#chat .me') && document.querySelector('#chat .fb') && !document.querySelector('#chat .typing')`, '真实本地问答结果');
      const before = await evaluate(`({chat: document.getElementById('chat').textContent, result: document.getElementById('res').textContent, tax: document.getElementById('taxRes').textContent})`);
      ensure(before.chat.trim() && before.result.trim() && before.tax.trim(), '切语言之前未建立完整旧结果');
      const immediate = await evaluate(`(() => {
        const selector = document.getElementById('langSel');
        selector.value = 'en';
        selector.dispatchEvent(new Event('change', {bubbles: true}));
        return {chat: document.getElementById('chat').textContent, result: document.getElementById('res').textContent, tax: document.getElementById('taxRes').textContent, verdict: STATE.verdict};
      })()`);
      ensure(immediate.chat === '' && immediate.result === '' && immediate.tax === '' && immediate.verdict === null, `语言切换未立即清除旧数据：${JSON.stringify(immediate)}`);
      await waitFor(`STATE.lang === 'en' && document.documentElement.lang === 'en' && document.getElementById('langSel').value === 'en' && document.getElementById('apiStatus').textContent === t('ui.status.connected', {version: STATE.data.meta.policy.version}) && latestResult && latestResult.lang === 'en' && !document.querySelector('#chat .typing')`, '英文重新加载');
      ensure(await evaluate(`document.getElementById('chat').textContent.trim() === '' && latestQuestion === '' && document.getElementById('aiSupplement').disabled`), '旧语言对话或 AI 补充状态残留');
      await noMissingKeys();
      return { from: 'ru', to: 'en', clearedImmediately: immediate };
    });
    await interaction('本机云通知明确不可用且没有云登录成功', async () => {
      const state = await evaluate(`({key: AppCloud.preview(), notice: document.getElementById('cloudNotice').textContent, expected: t(AppCloud.preview()), user: signedInUserId, authVisible: !document.getElementById('authForm').hidden, signedInHidden: document.getElementById('signedIn').hidden, signedInText: t('auth.signedIn'), sdk: !!(window.WorkBuddyCloud && typeof WorkBuddyCloud.createWorkBuddyCloud === 'function')})`);
      ensure(['cloud.preview', 'cloud.unavailable', 'cloud.domain'].includes(state.key), `本机错误地允许云会话：${JSON.stringify(state)}`);
      ensure(state.notice === state.expected && state.notice.trim() && state.notice !== state.signedInText && state.user === null && state.authVisible && state.signedInHidden, `云通知或身份状态错误：${JSON.stringify(state)}`);
      const cloudRequests = [...requests.values()].filter((item) => !item.url.startsWith(origin) && item.url !== SDK_URL && /workbuddy|auth|otp|session/i.test(item.url));
      ensure(!cloudRequests.length, `本机保护未阻止云请求：${JSON.stringify(cloudRequests)}`);
      return state;
    });
    if (screenshot) {
      await check('显式请求的可选截图', async () => {
        const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'), { flag: 'wx' });
        return { path: screenshot };
      });
    }
  } catch (error) {
    report.checks.push({ name: '验收基础设施', status: 'failed', error: error.stack || error.message });
    console.error(`验收基础设施失败：${error.message}`);
  } finally {
    for (const name of PLANNED_CHECKS) {
      if (!report.checks.some((item) => item.name === name)) skip(name, '浏览器基础设施在此检查前中断');
    }
    report.sdk.requests = [...requests.values()].filter((item) => item.url === SDK_URL);
    if (!navigationAttempted) {
      skip('真实 CDN SDK 下载并暴露官方入口', '尚未导航到应用，CDN 连通性未经验证');
    } else await check('真实 CDN SDK 下载并暴露官方入口', async () => {
      ensure(report.sdk.observations.length === LANGUAGES.length && report.sdk.observations.every((item) => item.available), `SDK 入口未在全部首屏可用：${JSON.stringify(report.sdk)}`);
      ensure(report.sdk.requests.some((item) => item.finished && item.status === 200 && !item.error), `未确认真实 CDN 下载完成：${JSON.stringify(report.sdk.requests)}`);
      return { verifiedGlobal: 'WorkBuddyCloud.createWorkBuddyCloud', requests: report.sdk.requests.length, cloudLoginTested: false };
    });
    if (diagnosticsReady && navigationAttempted) {
      await check('无浏览器未捕获异常及 console.error', () => {
        ensure(!report.diagnostics.exceptions.length && !report.diagnostics.consoleErrors.length && !report.diagnostics.browserErrors.length, JSON.stringify({ exceptions: report.diagnostics.exceptions, consoleErrors: report.diagnostics.consoleErrors, browserErrors: report.diagnostics.browserErrors }));
      });
      await check('无 CSP 错误', () => ensure(!report.diagnostics.cspErrors.length, JSON.stringify(report.diagnostics.cspErrors)));
    } else {
      skip('无浏览器未捕获异常及 console.error', '未完成浏览器诊断监听与应用导航');
      skip('无 CSP 错误', '未完成浏览器诊断监听与应用导航');
    }
    if (chrome) report.chromeStderr = chrome.stderr();
    if (chrome) {
      try { await terminateChrome(chrome); }
      catch (error) { report.cleanupErrors.push(`关闭 Chrome：${error.message}`); }
    }
    if (chrome) {
      report.chromeExit = { code: chrome.child.exitCode, signal: chrome.child.signalCode };
      report.chromeStderr = chrome.stderr();
    }
    if (cdp) cdp.close();
    if (server) {
      try {
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } catch (error) { report.cleanupErrors.push(`关闭 server：${error.message}`); }
    }
    if (store) {
      try { store.reset(); }
      catch (error) { report.cleanupErrors.push(`关闭 store：${error.message}`); }
    }
    if (live) live.reset();
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const chromeStopped = !chrome || !chrome.child.pid || chrome.child.exitCode !== null || chrome.child.signalCode !== null;
    for (const directory of ownedDirectories.reverse()) {
      if (!chromeStopped) { report.cleanupErrors.push(`Chrome 未退出，保留本脚本的临时目录：${directory}`); continue; }
      try { fs.rmSync(directory, { recursive: true, force: true }); }
      catch (error) { report.cleanupErrors.push(`删除本脚本临时目录 ${directory}：${error.message}`); }
    }
    if (report.cleanupErrors.length) report.checks.push({ name: '资源清理', status: 'failed', error: report.cleanupErrors.join('\n') });
  }
  const count = (status) => report.checks.filter((item) => item.status === status).length;
  report.summary = { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), total: report.checks.length };
  console.log(`验收结束：通过 ${report.summary.passed}，失败 ${report.summary.failed}，跳过 ${report.summary.skipped}`);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  runBrowserCheck(process.argv.slice(2)).then((report) => {
    process.exitCode = report.summary.failed || report.summary.skipped ? 1 : 0;
  }).catch((error) => {
    console.error(`浏览器验收无法启动：${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runBrowserCheck };
