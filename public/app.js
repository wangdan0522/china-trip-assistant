'use strict';

/* =========================================================
   入境游 APP · 前端
   - 文案：全部来自 /api/ui（服务端唯一文案源），前端零硬编码
   - 内容：目的地 / 政策 / 答疑 全部来自后端，且按 ?lang= 返回目标语言
   - 实时：天气、汇率、政策源监测来自 /api/live，带 stale 标记
   ========================================================= */

var STATE = {
  lang: 'en',
  view: 'exp',
  ui: {},
  data: { countries: [], dest: null, questions: [], policy: null, meta: null, live: null },
  verdict: null,
  greeted: false,
  cat: 'all',
  selectedDest: null
};

var LOCALE = { en: 'en-GB', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', ru: 'ru-RU' };

// 仅用于界面包尚不可用时的启动状态，不包含业务资料。
var BOOT_COPY = {
  en: { failed: 'Offline. Please retry.', retry: 'Retry', loading: 'Loading…' },
  zh: { failed: '连接不可用，请重试。', retry: '重试', loading: '正在加载…' },
  ja: { failed: '接続できません。再試行してください。', retry: '再試行', loading: '読み込み中…' },
  ko: { failed: '연결할 수 없습니다. 다시 시도하세요.', retry: '다시 시도', loading: '불러오는 중…' },
  es: { failed: 'Sin conexión. Inténtalo de nuevo.', retry: 'Reintentar', loading: 'Cargando…' },
  ru: { failed: 'Нет соединения. Повторите попытку.', retry: 'Повторить', loading: 'Загрузка…' }
};
function validLang(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(LOCALE, code);
}
function startupText(kind) {
  if (STATE.uiLang === STATE.lang) {
    return t(kind === 'failed' ? 'ui.serviceUnavailable' : kind === 'retry' ? 'ui.retry' : 'ui.status.loading');
  }
  return BOOT_COPY[STATE.lang][kind];
}
function renderLoadState(state) {
  STATE.loadState = state;
  $('appScreen').setAttribute('data-load-state', state);
  $('loadNotice').hidden = state === 'ready';
  $('loadMessage').textContent = state === 'ready' ? '' : startupText(state);
  $('retryLoad').textContent = startupText('retry');
  $('retryLoad').hidden = state !== 'failed';
  $('retryLoad').disabled = state === 'loading';
  if (state !== 'ready') setStatus(startupText(state), state === 'failed');
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function $(id) {
  return document.getElementById(id);
}

/** 取文案 + 替换 {param}。文案本身是受控内容，允许内联标签 */
function t(key, params) {
  var s = STATE.ui[key];
  if (s === undefined) return '⟦' + key + '⟧';
  if (!params) return s;
  return String(s).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
  });
}

function api(path, options) {
  var opts = options || {};
  var init = {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': LOCALE[STATE.lang] || 'en' }
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  var url = path + sep + 'lang=' + encodeURIComponent(STATE.lang);

  return fetch(url, init).then(function (res) {
    if (!res.ok) {
      var err = new Error('Request failed');
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

function fmtDate(iso) {
  if (!iso) return '—';
  var parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  try {
    return new Intl.DateTimeFormat(LOCALE[STATE.lang] || 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(d);
  } catch (e) {
    return iso;
  }
}

function fmtNum(n) {
  try {
    return new Intl.NumberFormat(LOCALE[STATE.lang] || 'en-GB').format(n);
  } catch (e) {
    return String(n);
  }
}

function fmtTime(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  try {
    return new Intl.DateTimeFormat(LOCALE[STATE.lang] || 'en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch (e) {
    return d.toISOString().slice(11, 16);
  }
}

var WX_ICON = { clear: '☀️', cloudy: '⛅', fog: '🌫️', drizzle: '🌦️', rain: '🌧️', snow: '🌨️', storm: '⛈️' };

function setStatus(text, bad) {
  var el = $('apiStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = bad ? '#B42318' : '#0E7C57';
  el.style.borderColor = bad ? '#F3C6C1' : '#BFE3D3';
  el.style.background = bad ? '#FEF3F2' : '#EAF7F1';
}

/* ---------------- 语言 ---------------- */

function setLang(code) {
  if (!validLang(code) || code === STATE.lang) return;
  STATE.lang = code;
  taxSequence++;
  clearTimeout(taxTimer);
  viewEpoch++;
  historySequence++;
  invalidateResult();
  clearTimeout(judgeTimer);
  if (aiController) aiController.abort();
  aiController = null;
  latestQuestion = '';
  $('aiStop').hidden = true;
  $('aiSupplement').disabled = true;
  $('chat').textContent = '';
  $('histBox').textContent = '';
  $('taxRes').textContent = '';
  STATE.greeted = false;
  try {
    localStorage.setItem('inbound.lang', code);
  } catch (e) {
    /* 隐私模式下忽略 */
  }
  document.documentElement.lang = code;
  loadAll();
}

function paintLangSwitcher(languages) {
  var sel = $('langSel');
  if (!sel) return;
  sel.innerHTML = languages
    .map(function (l) {
      var mark = l.reviewStatus && l.reviewStatus !== 'native' ? ' ·' : '';
      return '<option value="' + l.code + '">' + esc(l.native) + mark + '</option>';
    })
    .join('');
  sel.value = STATE.lang;
  $('langBadge').textContent = STATE.lang.toUpperCase();
}

/* ---------------- 静态文案 ---------------- */

function applyStatic() {
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) {
    var key = nodes[i].getAttribute('data-i18n');
    nodes[i].innerHTML = t(key);
  }
  var ph = document.querySelectorAll('[data-i18n-ph]');
  for (var j = 0; j < ph.length; j++) {
    ph[j].setAttribute('placeholder', t(ph[j].getAttribute('data-i18n-ph')));
  }
  $('ovTitle').textContent = t('ov.title');
  $('ovBody').innerHTML = t('ov.body');
  $('ovClose').textContent = t('ov.close');
}

/* ---------------- 导航 ---------------- */

function go(v, btn) {
  if (['exp', 'ask', 'prep', 'arr', 'dep'].indexOf(v) < 0) return;
  if ($('routeDetail') && !$('routeDetail').hidden) closeDest(false);
  var vs = document.querySelectorAll('.view');
  for (var i = 0; i < vs.length; i++) vs[i].classList.remove('on');
  $('v-' + v).classList.add('on');

  var bs = document.querySelectorAll('.tabs button');
  for (var j = 0; j < bs.length; j++) bs[j].classList.remove('on');
  if (btn) btn.classList.add('on');

  STATE.view = v;

  if (v === 'ask' && !STATE.greeted) {
    STATE.greeted = true;
    addBot(
      {
        a: t('ui.bot.intro'),
        src: t('ui.src.default')
      },
      { noFeedback: true }
    );
  }
  renderNotes(v);
}

function jump(v) {
  var bs = document.querySelectorAll('.tabs button');
  for (var i = 0; i < bs.length; i++) {
    if (bs[i].getAttribute('data-v') === v) return go(v, bs[i]);
  }
}

function toJudge() {
  jump('ask');
  setTimeout(showJudge, 140);
}

function showJudge() {
  var w = $('judgeWrap');
  w.style.display = 'block';
  judge();
  setTimeout(function () {
    w.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

function tog(el) {
  el.classList.toggle('on');
}

function flt(cat, btn) {
  var bs = document.querySelectorAll('.chips button');
  for (var i = 0; i < bs.length; i++) bs[i].classList.remove('on');
  if (btn) btn.classList.add('on');
  STATE.cat = cat;
  renderDest(cat);
}

function srcTog(btn) {
  var box = btn.nextElementSibling;
  if (box) box.classList.toggle('on');
}

function ovOn() {
  $('ov').classList.add('on');
}

function ovOff() {
  $('ov').classList.remove('on');
}

/* ---------------- 探索 ---------------- */

function renderChips() {
  var box = $('chips');
  if (!box || !STATE.data.dest) return;
  box.innerHTML = STATE.data.dest.categories
    .map(function (c) {
      return (
        '<button class="' + (c.id === STATE.cat ? 'on' : '') + '" data-c="' + esc(c.id) +
        '" data-act="flt">' + esc(c.name) + '</button>'
      );
    })
    .join('');
}

var DEST_ART = {
  'heritage-axis': 'heritage-axis', 'heritage-gardens': 'heritage-gardens',
  'nature-southwest': 'nature-southwest', 'city-skylines': 'city-skylines',
  'food-trail': 'food-trail', 'seasonal': 'seasonal'
};
function destArt(id) {
  return 'assets/' + (Object.prototype.hasOwnProperty.call(DEST_ART, id) ? DEST_ART[id] : 'heritage-axis') + '.jpg';
}
function destWeather(d) {
  var wx = d.weather;
  var kind = wx && Object.prototype.hasOwnProperty.call(WX_ICON, wx.cat) ? wx.cat : 'cloudy';
  if (!wx || typeof wx.temp !== 'number' || !Number.isFinite(wx.temp)) {
    return '<span class="bg wx off">' + esc(t('wx.offline')) + '</span>';
  }
  return '<span class="bg wx">' + esc(wx.temp) + '°C · ' + esc(t('wx.' + kind)) +
    (STATE.data.dest.live && STATE.data.dest.live.stale ? ' · ' + esc(t('live.cached')) : '') + '</span>';
}
function renderDest(cat) {
  var box = $('destList');
  if (!box || !STATE.data.dest) return;
  var items = STATE.data.dest.items.filter(function (d) {
    return !cat || cat === 'all' || d.cat === cat;
  });
  box.innerHTML = items.map(function (d) {
    var index = STATE.data.dest.items.indexOf(d) + 1;
    var verified = d.booking && d.booking.verified === true;
    return '<article class="exp" data-c="' + esc(d.cat) + '">' +
      '<div class="destination-image"><img src="' + destArt(d.id) + '" alt="" width="498" height="498" loading="lazy">' +
      '<span class="destination-number">' + ('0' + index).slice(-2) + '</span></div>' +
      '<div class="destination-body"><h4>' + esc(d.title) + '</h4><p>' + esc(d.desc) + '</p>' +
      '<div class="bgs">' + (d.badges || []).map(function (b) { return '<span class="bg">' + esc(b) + '</span>'; }).join('') + destWeather(d) + '</div>' +
      '<div class="destination-bottom"><button type="button" class="destination-view" data-act="openDest" data-id="' + esc(d.id) + '">' + esc(t('home.view')) + '<span aria-hidden="true">↗</span></button>' +
      '<span class="destination-pending">' + esc(t(verified ? 'ui.booking.verified' : 'ui.booking.unverified')) + '</span></div></div></article>';
  }).join('');
}
var detailReturnFocus = null;
function openDest(id, trigger) {
  if (!STATE.data.dest) return;
  var item = STATE.data.dest.items.find(function (d) { return d.id === id; });
  if (!item) return;
  STATE.selectedDest = item.id;
  detailReturnFocus = trigger || null;
  $('detailTitle').textContent = item.title;
  $('detailDescription').textContent = item.desc;
  $('detailImage').setAttribute('src', destArt(item.id));
  $('detailBadges').innerHTML = (item.badges || []).map(function (b) { return '<span class="bg">' + esc(b) + '</span>'; }).join('') + destWeather(item);
  $('detailNotice').textContent = STATE.data.dest.disclaimer || t('home.detail.note');
  $('routeDetail').hidden = false;
  $('views').setAttribute('inert', '');
  if ($('detailBack').focus) $('detailBack').focus();
}
function closeDest(restoreFocus) {
  $('routeDetail').hidden = true;
  $('views').removeAttribute('inert');
  STATE.selectedDest = null;
  var trigger = detailReturnFocus;
  detailReturnFocus = null;
  if (restoreFocus !== false && trigger && trigger.focus && trigger.isConnected) trigger.focus();
}
function browseDest() {
  $('inspiration').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function detailAsk() {
  var item = STATE.data.dest && STATE.data.dest.items.find(function (d) { return d.id === STATE.selectedDest; });
  closeDest(false);
  jump('ask');
  if (item) $('askin').value = item.title;
  if ($('askin').focus) $('askin').focus();
}

function bookableChip(v) {
  var map = {
    yes: ['#EAF7F1', '#0E7C57'],
    partial: ['#FFF4E5', '#9A5B00'],
    no: ['#FEF3F2', '#B42318'],
    na: ['#EAF7F1', '#0E7C57']
  };
  var c = map[v] || map.partial;
  var label = t('ui.bookable.' + (map[v] ? v : 'partial'));
  return '<span class="bg" style="background:' + c[0] + ';color:' + c[1] + '">' + esc(label) + '</span>';
}

function renderPstats() {
  var box = $('pstats');
  if (!box || !STATE.data.policy) return;

  box.innerHTML = STATE.data.policy.stats
    .map(function (s) {
      return (
        '<div class="pstat' + (s.hot ? ' hot' : '') + '">' +
        '<div class="num">' + esc(s.value) + (s.unit ? '<small>' + esc(s.unit) + '</small>' : '') + '</div>' +
        '<div class="lbl">' + s.label + '</div>' +
        '</div>'
      );
    })
    .join('');

  var cd = STATE.data.policy.countdown;
  var host = $('policyNotes');
  var notes = (STATE.data.policy.notes || []).map(function (n) {
    return '<div class="note ' + esc(n.tone) + '">' + n.text + '</div>';
  });
  if (cd) {
    var urgent = cd.daysUntilExpiry <= 60;
    notes.unshift(
      '<div class="note ' + (urgent ? 'o' : 'b') + '" style="margin-top:10px">' +
        esc(t(cd.daysUntilExpiry < 0 ? 'policy.expired' : 'policy.countdown', {
          date: fmtDate(cd.expires), days: cd.daysUntilExpiry
        })) +
        '</div>'
    );
  }
  host.innerHTML = notes.join('');
}

function renderSteps() {
  var box = $('steps');
  if (!box || !STATE.data.policy) return;
  box.innerHTML = STATE.data.policy.steps
    .map(function (s) {
      return (
        '<div class="stp' + (s.hot ? ' hotc' : '') + '">' +
        '<span class="sn">' + esc(s.n) + '</span>' +
        '<div class="sc2">' +
        '<div class="st">' + esc(s.title) + '</div>' +
        '<div class="sd">' + esc(s.desc) + '</div>' +
        '</div>' +
        '<span class="sw">' + esc(s.when) + '</span>' +
        '</div>'
      );
    })
    .join('');
}

/* ---------------- 准备 ---------------- */

function renderPrepStatic() {
  var before = $('beforeList');
  if (before) {
    before.innerHTML = [1, 2, 3, 4, 5]
      .map(function (n) {
        return '<label class="ck" data-act="tog"><span class="bx"></span><span>' + t('prep.before.' + n) + '</span></label>';
      })
      .join('');
  }
  var imm = $('immRows');
  if (imm) {
    imm.innerHTML = [1, 2, 3, 4]
      .map(function (n) {
        return '<div class="row"><span class="k">' + t('prep.imm.' + n + 'k') + '</span><span class="v">' + t('prep.imm.' + n + 'v') + '</span></div>';
      })
      .join('');
  }
  var tl = $('timeline');
  if (tl) {
    tl.innerHTML = [1, 2, 3, 4]
      .map(function (n) {
        return '<div class="it"><div class="t">' + t('prep.time.' + n + 't') + '</div><div class="d">' + t('prep.time.' + n + 'd') + '</div></div>';
      })
      .join('');
  }
}

/* ---------------- 资格判定 ---------------- */

var judgeTimer = null;
var judgeSequence = 0;
var historySequence = 0;
var viewEpoch = 0;
var loadSequence = 0;
var latestResult = null;
var signedInUserId = null;
var aiController = null;
var latestQuestion = '';
var authBusy = false;

function judgeInput() {
  return { countryCode: $('nat').value, passportType: $('ppt').value, purpose: $('pur').value,
    stayDays: Number($('stay').value), port: $('inp').value, next: $('nxt').value };
}
function invalidateResult() {
  judgeSequence++;
  latestResult = null;
  STATE.verdict = null;
  $('saveResult').hidden = true;
  $('saveStatus').textContent = '';
  $('res').textContent = '';
  $('prepVerdict').textContent = '';
  $('prepExpiry').textContent = '';
}
function scheduleJudge() {
  invalidateResult();
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(judge, 220);
}
function judge() {
  if (!$('judgeWrap') || $('judgeWrap').style.display === 'none') return Promise.resolve();
  var payload = judgeInput();
  var signature = JSON.stringify(payload);
  invalidateResult();
  var sequence = judgeSequence;
  var lang = STATE.lang;
  return api('/api/eligibility', { method: 'POST', body: payload })
    .then(function (r) {
      if (sequence !== judgeSequence || lang !== STATE.lang || signature !== JSON.stringify(judgeInput())) return;
      renderVerdict(r);
      latestResult = { payload: payload, signature: signature, result: r, lang: lang, saved: false, saving: false };
      $('saveResult').hidden = false;
      $('saveResult').disabled = false;
    })
    .catch(function (err) {
      if (sequence !== judgeSequence || lang !== STATE.lang) return;
      $('res').textContent = localError(err);
    });
}
function loadHistory() {
  var box = $('histBox');
  var sequence = ++historySequence;
  var lang = STATE.lang;
  if (!signedInUserId) { box.textContent = t('history.signIn'); return Promise.resolve(); }
  return AppCloud.loadHistory().then(function (items) {
    if (sequence !== historySequence || lang !== STATE.lang || !signedInUserId) return;
    var countryMap = {};
    STATE.data.countries.forEach(function (c) { countryMap[c.code] = c.name; });
    box.innerHTML = '<div class="hist"><div class="histt">' + esc(t('hist.title')) + '</div>' +
      (items || []).map(function (it) {
        return '<div class="histrow"><b>' + esc(countryMap[it.country_code] || it.country_code) + '</b>' +
          '<span>' + esc(it.stay_days) + ' · ' + esc(it.port) + '</span><em>' + esc(it.code) + '</em></div>';
      }).join('') + (!(items || []).length ? esc(t('hist.empty')) : '') + '</div>';
  }).catch(function (error) {
    if (sequence === historySequence && lang === STATE.lang) box.textContent = t(AppCloud.errorKey(error));
  });
}
async function saveResult() {
  var current = latestResult;
  if (!current || current.saved || current.saving || current.signature !== JSON.stringify(judgeInput())) return;
  if (!signedInUserId) { $('saveStatus').textContent = t('history.signIn'); $('accountPanel').open = true; return; }
  current.saving = true;
  $('saveResult').disabled = true;
  var userId = signedInUserId;
  var epoch = viewEpoch;
  try {
    await AppCloud.saveHistory({ country_code: current.payload.countryCode, purpose: current.payload.purpose,
      stay_days: current.payload.stayDays, port: current.payload.port, route: current.result.route || current.payload.next,
      code: current.result.code, lang: current.lang });
    if (current !== latestResult || userId !== signedInUserId || epoch !== viewEpoch) return;
    current.saved = true;
    $('saveStatus').textContent = t('history.saved');
    loadHistory();
  } catch (error) {
    if (current === latestResult && userId === signedInUserId && epoch === viewEpoch) $('saveStatus').textContent = t(AppCloud.errorKey(error));
  } finally {
    current.saving = false;
    if (current === latestResult) $('saveResult').disabled = current.saved;
  }
}
function updateAuthButtons() {
  var seconds = AppCloud.remaining();
  $('sendCode').disabled = authBusy || seconds > 0;
  $('sendCode').textContent = seconds ? t('auth.resendIn', { seconds: seconds }) : t('auth.sendCode');
  $('verifyCode').disabled = authBusy;
  $('authEmail').disabled = authBusy;
  $('authCode').disabled = authBusy;
}
async function sendCode() {
  if (authBusy || !$('authEmail').reportValidity()) return;
  authBusy = true;
  updateAuthButtons();
  try {
    await AppCloud.sendCode($('authEmail').value.trim());
    $('cloudNotice').textContent = t('auth.codeSent');
  } catch (error) { $('cloudNotice').textContent = t(AppCloud.errorKey(error)); }
  finally { authBusy = false; updateAuthButtons(); }
}
async function verifyCode(event) {
  event.preventDefault();
  if (authBusy) return;
  authBusy = true;
  updateAuthButtons();
  try {
    await AppCloud.verifyCode($('authEmail').value.trim(), $('authCode').value.trim());
    $('authCode').value = '';
    $('cloudNotice').textContent = t('auth.signedIn');
    loadHistory();
  } catch (error) { $('cloudNotice').textContent = t(AppCloud.errorKey(error)); }
  finally { authBusy = false; updateAuthButtons(); }
}
function clearPrivateUI() {
  signedInUserId = null;
  historySequence++;
  $('histBox').textContent = t('history.signIn');
  $('saveStatus').textContent = '';
  $('chat').textContent = '';
  STATE.greeted = false;
  latestQuestion = '';
  $('askin').value = '';
  $('authEmail').value = '';
  $('authCode').value = '';
  viewEpoch++;
  if (aiController) aiController.abort();
  aiController = null;
  $('aiStop').hidden = true;
  $('aiSupplement').disabled = true;
}
async function signOut() {
  clearPrivateUI();
  $('authForm').hidden = false;
  $('signedIn').hidden = true;
  try { await AppCloud.signOut(); $('cloudNotice').textContent = t('auth.signedOut'); }
  catch (error) { $('cloudNotice').textContent = t(AppCloud.errorKey(error)); }
}
function initCloud() {
  AppCloud.subscribe(function (session) {
    var userId = session && session.user && session.user.id || null;
    var changed = userId !== signedInUserId;
    if (changed) clearPrivateUI();
    signedInUserId = userId;
    $('authForm').hidden = !!signedInUserId;
    $('signedIn').hidden = !signedInUserId;
    if (changed && signedInUserId) loadHistory();
  });
  var preview = AppCloud.preview();
  $('cloudNotice').textContent = preview ? t(preview) : '';
  AppCloud.getSession().catch(function (error) { $('cloudNotice').textContent = t(AppCloud.errorKey(error)); });
  setInterval(updateAuthButtons, 1000);
}
async function supplement() {
  if (!latestQuestion || aiController) return;
  var controller = new AbortController();
  aiController = controller;
  var epoch = viewEpoch;
  $('aiSupplement').disabled = true;
  $('aiStop').hidden = false;
  var message = document.createElement('div');
  message.className = 'msg bot';
  var bubble = document.createElement('div');
  bubble.className = 'bub ai-text';
  var label = document.createElement('strong');
  label.textContent = t('ai.label');
  var output = document.createElement('div');
  var status = document.createElement('p');
  status.className = 'cloud-status';
  status.textContent = t('ai.generating');
  bubble.append(label, output, status);
  message.append(bubble);
  $('chat').append(message);
  try {
    await AppCloud.supplement(latestQuestion, STATE.lang, controller.signal, function (text) {
      if (epoch === viewEpoch) output.textContent = text;
    });
    if (epoch === viewEpoch) status.textContent = t('ai.complete');
  } catch (error) {
    if (epoch === viewEpoch) status.textContent = (output.textContent ? t('ai.incomplete') + ' ' : '') + t(AppCloud.errorKey(error));
  } finally {
    if (aiController === controller) {
      aiController = null;
      $('aiStop').hidden = true;
      $('aiSupplement').disabled = !latestQuestion;
    }
  }
}

function renderVerdict(r) {
  STATE.verdict = r;

  var list = r.points
    .map(function (p) {
      var style = p.tone === 'warn' ? ' style="color:#B4630C"' : p.tone === 'ok' ? ' style="color:#0E7C57"' : '';
      return '<li' + style + '>' + p.text + '</li>';
    })
    .join('');

  var policyLine = '';
  if (r.policy && r.policy.expires) {
    var urgent = typeof r.policy.daysUntilExpiry === 'number' && r.policy.daysUntilExpiry <= 60;
    policyLine =
      '<div class="byline"' + (urgent ? ' style="color:#B4630C"' : '') + '>' +
      esc(t('policy.expiryLine', { version: r.policy.version, date: fmtDate(r.policy.expires),
        days: typeof r.policy.daysUntilExpiry === 'number' ? r.policy.daysUntilExpiry : '—' })) +
      '</div>';
  }

  var warnHtml = (r.warnings || [])
    .map(function (w) {
      return '<div class="vwarn"><b>' + esc(w.title) + '</b><div>' + esc(w.text) + '</div>' +
        '<small>' + esc(w.point) + '</small></div>';
    })
    .join('');

  $('res').innerHTML =
    '<div class="res ' + esc(r.code) + '">' +
    '<div class="big">' + esc(r.title) + '</div>' +
    '<div class="why">' + r.why + '</div>' +
    '<ul>' + list + '</ul>' +
    warnHtml +
    policyLine +
    '<div class="byline">' + esc(r.byline) + '</div>' +
    sourceLinks(r.sources) + '</div>';

  var pv = $('prepVerdict');
  if (pv) pv.textContent = r.title;
  var pe = $('prepExpiry');
  if (pe && r.policy && r.policy.expires) pe.textContent = fmtDate(r.policy.expires);
}

/* ---------------- 答疑 ---------------- */

function addMe(txt) {
  var chat = $('chat');
  chat.insertAdjacentHTML('beforeend', '<div class="msg me"><span class="av">' + esc(t('ui.me')) + '</span><div class="bub">' + esc(txt) + '</div></div>');
  chat.parentNode.scrollTop = chat.parentNode.scrollHeight;
}

function bubbleBot(items, opt) {
  opt = opt || {};
  var h = '<span class="av">Q&amp;A</span><div class="bub">';
  h += '<div>' + items.a + '</div>';

  if (items.li && items.li.length) {
    h += '<ul>' + items.li.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
  }
  if (items.fees && items.fees.length) {
    h += '<div class="sub2">' + esc(t('ask.fees')) + '</div><ul>' +
      items.fees.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
  }
  if (items.tips && items.tips.length) {
    h += '<div class="sub2">' + esc(t('ask.tips')) + '</div><ul>' +
      items.tips.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
  }
  if (items.warn) h += '<div class="guard">&#9888; ' + items.warn + '</div>';
  if (items.tail) h += '<div class="guard">&#9432; ' + items.tail + '</div>';
  if (items.yes) h += '<button class="mini" data-act="judge">' + t('ask.judge.cta') + '</button>';
  if (items.src) {
    h += '<button class="srcbtn" data-act="src">' + t('ui.src.button') + '</button>' +
      '<div class="srcbox">' + items.src + '</div>';
  }
  if (items.id && !opt.noFeedback) {
    h += '<div class="fb" data-answer="' + esc(items.id) + '">' +
      '<span>' + t('ui.feedback.q') + '</span>' +
      '<button data-act="fb" data-v="1">' + t('ui.feedback.yes') + '</button>' +
      '<button data-act="fb" data-v="0">' + t('ui.feedback.no') + '</button>' +
      '</div>';
  }
  return '<div class="msg bot">' + h + '</div></div>';
}

function addBot(items, opt) {
  var epoch = viewEpoch;
  var chat = $('chat');
  var tid = 't' + Math.random().toString(36).slice(2, 7);
  chat.insertAdjacentHTML(
    'beforeend',
    '<div class="msg bot" id="' + tid + '"><span class="av">Q&amp;A</span><div class="bub typing"><span></span><span></span><span></span></div></div>'
  );
  chat.parentNode.scrollTop = chat.parentNode.scrollHeight;
  setTimeout(function () {
    if (epoch !== viewEpoch) return;
    var el = $(tid);
    if (el) el.outerHTML = bubbleBot(items, opt);
    chat.parentNode.scrollTop = chat.parentNode.scrollHeight;
  }, 380);
}

function askById(id) {
  var q = STATE.data.questions.filter(function (x) { return x.id === id; })[0];
  if (!q) return;
  addMe(q.q);
  latestQuestion = q.q;
  $('aiSupplement').disabled = !!aiController;
  var epoch = viewEpoch;
  api('/api/ask', { method: 'POST', body: { id: id } })
    .then(function (r) { if (epoch === viewEpoch) addBot(r.item); })
    .catch(function (err) { if (epoch === viewEpoch) addBot({ a: esc(localError(err)) }); });
}

function send() {
  var el = $('askin');
  var v = (el.value || '').trim();
  if (!v) return;
  el.value = '';
  addMe(v);
  latestQuestion = v;
  $('aiSupplement').disabled = !!aiController;
  var epoch = viewEpoch;
  api('/api/ask', { method: 'POST', body: { text: v } })
    .then(function (r) {
      if (epoch !== viewEpoch) return;
      if (r.type === 'answer') return addBot(r.item);
      addBot({
        a: r.fallback,
        li: r.suggestions.map(function (s) { return esc(s.q); }),
        src: t('ui.fallback.src')
      });
    })
    .catch(function (err) {
      if (epoch === viewEpoch) addBot({ a: esc(localError(err)) });
    });
}

async function sendFeedback(btn, helpful) {
  var wrap = btn.parentNode;
  if (wrap.getAttribute('aria-busy') === 'true') return;
  var epoch = viewEpoch;
  wrap.setAttribute('aria-busy', 'true');
  var buttons = wrap.querySelectorAll('button');
  buttons.forEach(function (button) { button.disabled = true; });
  var status = wrap.querySelector('.feedback-status');
  if (!status) { status = document.createElement('span'); status.className = 'feedback-status'; wrap.append(status); }
  status.textContent = '';
  try {
    await AppCloud.feedback(wrap.getAttribute('data-answer'), helpful, STATE.lang);
    if (epoch === viewEpoch) wrap.textContent = t(helpful ? 'ui.feedback.thanks' : 'ui.feedback.improve');
  } catch (error) {
    if (epoch === viewEpoch) {
      status.textContent = t('feedback.failed') + ' ' + t(AppCloud.errorKey(error));
      buttons.forEach(function (button) { button.disabled = false; });
    }
  } finally { wrap.removeAttribute('aria-busy'); }
}

/* ---------------- 退税 ---------------- */

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function sourceLinks(items) {
  var links = (items || []).map(function (item) {
    try {
      var url = new URL(item.url);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      return '<a target="_blank" rel="noopener noreferrer" href="' + esc(url.href) + '">' +
        esc(item.document || url.hostname + url.pathname) + '</a>';
    } catch (e) { return ''; }
  }).filter(Boolean);
  return links.length ? '<div class="source-links"><b>' + esc(t('policy.sources')) + '</b>' + links.join('') + '</div>' : '';
}

function localError(error) {
  if (error && error.status >= 400 && error.status < 500) return t('ui.validation');
  return t('ui.serviceUnavailable');
}

var taxSequence = 0;
var taxTimer = null;
function scheduleTax() {
  taxSequence++;
  $('taxRes').textContent = '';
  clearTimeout(taxTimer);
  taxTimer = setTimeout(tax, 240);
}
function tax() {
  var sequence = ++taxSequence;
  var epoch = viewEpoch;
  var v = $('shopDate').value;
  var route = $('taxRoute').value;
  $('agreementField').hidden = route !== 'instant';
  $('taxRes').textContent = '';
  if (!v) return Promise.resolve();
  if (!$('shopDate').checkValidity() || (route === 'instant' && !$('agreementDeadline').checkValidity())) {
    $('taxRes').textContent = t('ui.validation');
    return Promise.resolve();
  }
  var amt = $('shopAmt').value;
  if (!$('shopAmt').checkValidity() || (amt !== '' && (!Number.isFinite(Number(amt)) || Number(amt) < 0 || Number(amt) > 1000000000))) {
    $('taxRes').textContent = t('ui.tax.amountInvalid');
    return Promise.resolve();
  }
  var body = { shoppingDate: v, route: route, currency: $('curSel').value };
  if (amt !== '') body.amount = Number(amt);
  if (route === 'instant' && $('agreementDeadline').value) body.agreementDeadline = $('agreementDeadline').value;
  return api('/api/taxfree', { method: 'POST', body: body })
    .then(function (r) {
      if (epoch !== viewEpoch || sequence !== taxSequence) return;
      if (r.blocked) {
        $('taxRes').innerHTML = '<p class="tax-reminder">' + esc(t('ui.serviceUnavailable')) + '</p>' + sourceLinks(r.sources);
        return;
      }
      var missing = r.status === 'needs_agreement' || !r.deadline;
      var cls = r.status === 'expired' ? 'C' : 'B';
      var statusKey = missing ? 'ui.tax.needsAgreement' : r.route === 'instant' ? 'ui.tax.agreementStatus' :
        r.status === 'expired' ? 'ui.tax.expired' : r.status === 'critical' ? 'ui.tax.critical' : 'ui.tax.ok';
      var tip = missing ? t('dep.notice.needsAgreement') : r.daysLeft < 0 ? t('ui.tax.over') : t('ui.tax.left', { days: r.daysLeft });
      var est = '';
      if (r.estimate) {
        var e = r.estimate;
        var range = '¥' + fmtNum(e.grossMinCNY) + '–¥' + fmtNum(e.grossMaxCNY);
        if (e.conversionAvailable && e.currency !== 'CNY') {
          range += ' ≈ ' + e.currency + ' ' + fmtNum(e.grossMinLocal) + '–' + fmtNum(e.grossMaxLocal);
        }
        est = '<div class="rows"><div class="row"><span class="k">' + esc(t('dep.est')) +
          '</span><span class="v">' + esc(range) + '</span></div></div>' +
          '<p class="tax-reminder">' + esc(t('dep.estimate.grossRange')) + ' ' + esc(t('ui.tax.feeUnknown')) + '</p>' +
          (!e.conversionAvailable ? '<p class="tax-reminder">' + esc(t('ui.tax.rateUnavailable')) + '</p>' :
            e.rateAt ? '<p class="tax-reminder">' + esc(t('live.updated', { time: e.rateAt })) + '</p>' : '');
      }
      $('taxRes').innerHTML = '<div class="res ' + cls + '"><div class="big">' +
        esc(missing ? t('ui.tax.needsAgreement') : t('ui.tax.leave_by', { date: fmtDate(r.deadline) })) +
        '</div><div class="why">' + esc(tip) + '</div></div>' +
        '<div class="rows"><div class="row"><span class="k">' + esc(t('ui.tax.purchase_row')) +
        '</span><span class="v">' + esc(fmtDate(r.shoppingDate)) + '</span></div>' +
        '<div class="row"><span class="k">' + esc(t('ui.tax.deadline_row')) + '</span><span class="v">' + esc(fmtDate(r.deadline)) + '</span></div>' +
        '<div class="row"><span class="k">' + esc(t('ui.tax.status_row')) + '</span><span class="v">' + esc(t(statusKey)) + '</span></div></div>' +
        (!missing ? '<p class="tax-reminder">' + esc(t(r.noticeKey)) + '</p>' : '') + est + sourceLinks(r.sources);
    }).catch(function (err) {
      if (epoch !== viewEpoch || sequence !== taxSequence) return;
      $('taxRes').textContent = localError(err);
    });
}

/* ---------------- 右侧内部面板（中文，给评审看） ---------------- */

var STAGES = ['好奇', '种草', '评估', '决策', '准备', '在途', '离境'];
var COVER = { exp: [0, 1, 2], ask: [2, 3], prep: [3, 4], arr: [5], dep: [6] };

function funnel(v) {
  var cv = COVER[v] || [];
  var out = '<div class="fn">';
  for (var i = 0; i < STAGES.length; i++) {
    out += '<div class="fs' + (cv.indexOf(i) >= 0 ? ' on' : '') + '"><span class="fo"></span><span class="fl">' + STAGES[i] + '</span></div>';
  }
  return out + '</div>';
}

var NOTES = {
  exp: ['探索 · 主题 + 政策 + 流程',
    '<p>顺序是<b>心理顺序</b>而不是功能顺序：<b>主题（想不想去）→ 政策（能不能去）→ 流程（怎么去）</b>。</p>' +
    '<div class="kv"><i>&#9656;</i><span>政策段停在<b>概览层</b>：三个数字卡 + 时效倒计时。给的是「大概什么情况」，不是「你行不行」</span></div>' +
    '<div class="kv"><i>&#9656;</i><span>目的地卡新增<b>实时天气</b>（Open-Meteo），以及<b>「护照能不能线上订」</b>——这是平台不做的苦活</span></div>' +
    '<div class="kv"><i>&#9656;</i><span>五个 tab 的文案<b>全部走 /api/ui</b>，切语言不刷新页面、不改前端代码</span></div>'],
  ask: ['答疑 · Agent 前台 + 引擎后台',
    '<p>固定问答的问题不在内容，在形式：它<b>要求用户自己找到自己的问题</b>。</p>' +
    '<div class="kv"><i>&#9656;</i><span>涉资格的问题<b>不由模型作答</b>，走确定性引擎，结论下明确标「引擎输出，非模型输出」</span></div>' +
    '<div class="kv"><i>&#9656;</i><span>引擎只产出<b>消息键 + 参数</b>，不产出自然语言——加语种不会改错规则</span></div>' +
    '<div class="kv"><i>&#9656;</i><span>关键词匹配同时索引<b>当前语种 + 英文</b>，切到日语也能用英文问</span></div>'],
  prep: ['准备 · 决策之后才需要',
    '<p>状态卡 + 待办 + 入境卡字段 + 时间线，是「已决定用户」的主屏。</p>' +
    '<div class="kv"><i>&#9656;</i><span>顶部那句「还没有行程？」是<b>漏斗回流口</b></span></div>' +
    '<div class="kv"><i>&#9656;</i><span>日期/数字一律走 <b>Intl</b> 本地化：同一句结论在 6 个语种里格式都不一样</span></div>'],
  arr: ['在路上 · 入境那几天',
    '<p>只放会<b>真的出事</b>的事。</p>' +
    '<div class="kv"><i>&#9656;</i><span>被拒住那段话术<b>始终是英文</b>——它是给中国前台看的，不随界面语言变</span></div>'],
  dep: ['离境 · 收口',
    '<p>这一屏<b>没有任何交易</b>。只做时间提醒与扣费前参考范围，不确认资格或实际退款。</p>' +
    '<div class="kv"><i>&#9656;</i><span>普通口岸提醒按90天；即买即退只提醒实际协议日。金额显示<b>8%–11%扣费前范围</b>，不假设手续费</span></div>' +
    '<div class="kv"><i>&#9656;</i><span>战略意义不在功能——<b>退税是把用户留到「离境那天」的唯一钩子</b></span></div>']
};

function ago(ts) {
  if (!ts) return '—';
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  return Math.round(s / 3600) + ' 小时前';
}

function renderLivePanel() {
  if ($('notes').hidden) return;
  var box = $('livePanel');
  if (!box) return;
  var L = STATE.data.live;
  if (!L) {
    box.innerHTML = '<div class="lbox"><h4>实时数据</h4><div class="lrow">加载中…</div></div>';
    return;
  }
  var w = L.weather || {};
  var f = L.fx || {};
  var p = L.policyWatch || {};

  var wxRows = (w.items || [])
    .slice(0, 6)
    .map(function (it) {
      var d = (STATE.data.dest ? STATE.data.dest.items : []).filter(function (x) { return x.id === it.id; })[0];
      return '<div class="lrow"><span>' + esc(d ? d.title : it.id) + '</span><b>' + (it.temp === null ? '—' : it.temp + '°C') + '</b></div>';
    })
    .join('');

  var fxRows = Object.keys(f.rates || {})
    .slice(0, 6)
    .map(function (c) {
      return '<div class="lrow"><span>1 CNY</span><b>' + Number(f.rates[c]).toFixed(4) + ' ' + c + '</b></div>';
    })
    .join('');

  var watchRows = (p.sources || [])
    .map(function (s) {
      var badge =
        s.status === 'changed' ? '<em class="bad">有变化·待复核</em>'
          : s.status === 'unreachable' ? '<em class="warn">无法访问</em>'
            : s.status === 'baseline' ? '<em>已建基线</em>'
              : '<em class="ok">无变化</em>';
      return '<div class="lrow"><span>' + esc(s.name) + '</span>' + badge + '</div>' +
        '<div class="lmeta">' + s.titleCount + ' 条相关标题 · ' + ago(s.checkedAt) + (s.error ? ' · ' + esc(s.error) : '') + '</div>';
    })
    .join('');

  var ph = STATE.data.policyHealth || {};
  var stg = STATE.data.storage || {};
  var phBadge = ph.status === 'expired' ? t('panel.expired') : ph.status === 'review' ? t('panel.review') : t('panel.ok');
  var ruleRows = (ph.rules || [])
    .map(function (r) {
      var cls = r.status === 'expired' || r.status === 'retired' ? 'bad'
        : r.status === 'needs_review' ? 'warn' : 'ok';
      var tail = r.expiresOn || (r.daysToExpiry === null ? '—' : r.daysToExpiry + 'd');
      return '<div class="lrow"><span>' + esc(r.id) + '</span><em class="' + cls + '">' + esc(tail) + '</em></div>';
    })
    .join('');
  var counts = stg.counts || {};

  box.innerHTML =
    '<div class="lbox">' +
    '<h4>实时数据 <span class="live">' + (w.ok && f.ok && !w.stale && !f.stale ? 'LIVE' : 'DEGRADED') + '</span></h4>' +
    '<div class="lsec">' + esc(w.provider || '—') + ' <span>' + (w.stale ? '缓存' : ago(w.fetchedAt)) + '</span></div>' + (wxRows || '<div class="lrow">—</div>') +
    '<div class="lsec">汇率 · CNY 基准 <span>' + (f.updatedAt ? esc(String(f.updatedAt).slice(5, 22)) : '—') + '</span></div>' + (fxRows || '<div class="lrow">—</div>') +
    '<div class="lsec">政策源监测 <span>' + (p.needsReview ? '需人工复核' : '正常') + '</span></div>' + (watchRows || '<div class="lrow">—</div>') +
    '<div class="lfine">实时源只做「变化检测」，不自动改判定规则；规则变更走人工复核 + 发版。</div>' +
    '</div>' +

    '<div class="lbox">' +
    '<h4>' + esc(t('panel.policy')) + ' <span class="live">' + esc(phBadge) + '</span></h4>' +
    '<div class="lsec">' + esc(ph.version || '—') + ' <span>' +
      (ph.counts ? ph.counts.active + '/' + ph.counts.total : '—') + '</span></div>' +
    (ruleRows || '<div class="lrow">—</div>') +
    (ph.soonestExpiry ? '<div class="lfine">最近到期 ' + esc(ph.soonestExpiry.id) + ' · ' +
      esc(ph.soonestExpiry.date) + ' · ' + ph.soonestExpiry.days + ' 天后自动停止判定</div>' : '') +
    '</div>' +

    '<div class="lbox">' +
    '<h4>' + esc(t('panel.storage')) + ' <span class="live">' +
      esc(stg.mode === 'sqlite' ? t('panel.db') : t('panel.file')) + '</span></h4>' +
    '<div class="lrow"><span>feedback / history / audit</span><b>' +
      (counts.feedback || 0) + ' / ' + (counts.history || 0) + ' / ' + (counts.policyAudit || 0) + '</b></div>' +
    '<div class="lfine">' + esc(stg.engine || '—') + ' · ' +
      (stg.writable ? '可写' : '只读降级') +
      (stg.degradedReason ? ' · ' + esc(String(stg.degradedReason).slice(0, 60)) : '') + '</div>' +
    '</div>';
}

function renderNotes(v) {
  if ($('notes').hidden) return;
  var body = $('noteBody');
  if (!body) return;
  var d = NOTES[v];
  renderLivePanel();
  if (!d) return;
  body.innerHTML =
    '<div class="nhead"><h3>' + d[0] + '</h3><div class="nsub">' + v.toUpperCase() + ' · 当前语种 ' +
    STATE.lang.toUpperCase() + '</div></div>' +
    '<div class="fh">这一段落在「从心动到离境」的哪个位置</div>' + funnel(v) + d[1];
}

/* ---------------- 启动 ---------------- */

function bindEvents() {
  $('authForm').addEventListener('submit', verifyCode);
  document.addEventListener('keydown', function (event) {
    if ($('routeDetail').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDest(); }
    if (event.key === 'Tab') {
      var buttons = $('routeDetail').querySelectorAll('button:not([disabled])');
      if (!buttons.length) return;
      var first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  ['nat', 'ppt', 'pur', 'stay', 'inp', 'nxt'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('change', scheduleJudge);
    el.addEventListener('input', scheduleJudge);
  });

  ['shopDate', 'taxRoute', 'agreementDeadline', 'curSel'].forEach(function (id) {
    $(id).addEventListener('change', scheduleTax);
  });
  $('askin').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send();
  });
  $('langSel').addEventListener('change', function () { setLang(this.value); });
  $('shopAmt').addEventListener('input', scheduleTax);

  // 全部交互走事件委托：CSP 里不再需要 unsafe-inline，
  // 动态插入的卡片（含用户输入渲染）也自动生效。
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    var v = el.getAttribute('data-v');
    if (el.tagName === 'A') e.preventDefault();
    if (act === 'account') {
      var account = $('accountPanel');
      account.open = !account.open;
    }
    else if (act === 'browse') browseDest();
    else if (act === 'openDest') openDest(el.getAttribute('data-id'), el);
    else if (act === 'closeDest') closeDest();
    else if (act === 'detailAsk') detailAsk();
    else if (act === 'detailPrep') { closeDest(false); jump('prep'); }
    else if (act === 'go') go(v, el);
    else if (act === 'jump') jump(v);
    else if (act === 'toJudge') toJudge();
    else if (act === 'send') send();
    else if (act === 'ovOn') ovOn();
    else if (act === 'ovOff') ovOff();
    else if (act === 'flt') flt(el.getAttribute('data-c'), el);
    else if (act === 'tog') tog(el);
    else if (act === 'judge') showJudge();
    else if (act === 'src') srcTog(el);
    else if (act === 'fb') sendFeedback(el, v === '1');
    else if (act === 'ask') askById(el.getAttribute('data-qid'));
    else if (act === 'sendCode') sendCode();
    else if (act === 'signOut') signOut();
    else if (act === 'saveResult') saveResult();
    else if (act === 'aiSupplement') supplement();
    else if (act === 'aiStop' && aiController) aiController.abort();
  });
}

function loadAll() {
  var sequence = ++loadSequence;
  var lang = STATE.lang;
  STATE.ui = {};
  STATE.uiLang = null;
  STATE.data = { countries: [], dest: null, questions: [], policy: null, meta: null, live: null };
  viewEpoch++;
  historySequence++;
  taxSequence++;
  clearTimeout(taxTimer);
  clearTimeout(judgeTimer);
  invalidateResult();
  if (aiController) aiController.abort();
  aiController = null;
  latestQuestion = '';
  STATE.greeted = false;
  ['chat', 'histBox', 'taxRes', 'noteBody', 'livePanel', 'cloudNotice'].forEach(function (id) { $(id).textContent = ''; });
  document.documentElement.lang = lang;
  if ($('routeDetail')) closeDest(false);
  renderLoadState('loading');
  var uiRequest = api('/api/ui').then(function (ui) {
    if (sequence !== loadSequence || lang !== STATE.lang) return ui;
    if (ui.lang !== lang || !ui.ui || typeof ui.ui !== 'object') throw new Error('Invalid interface bundle');
    STATE.ui = ui.ui;
    STATE.uiLang = lang;
    document.documentElement.dir = ui.dir || 'ltr';
    applyStatic();
    renderLoadState(STATE.loadState);
    return ui;
  });
  return Promise.allSettled([
    uiRequest,
    api('/api/languages'),
    api('/api/meta'),
    api('/api/countries'),
    api('/api/destinations?weather=0'),
    api('/api/questions'),
    api('/api/policy'),
    api('/api/policy/health'),
    api('/api/health')
  ])
    .then(function (res) {
      if (sequence !== loadSequence || lang !== STATE.lang) return;
      if (res.some(function (result) { return result.status === 'rejected'; })) throw new Error('Startup unavailable');
      res = res.map(function (result) { return result.value; });
      var langs = res[1], meta = res[2], countries = res[3], dest = res[4], questions = res[5], policy = res[6],
        policyHealth = res[7], health = res[8];

      STATE.data = {
        countries: countries.items,
        dest: dest,
        questions: questions.items,
        policy: policy,
        meta: meta,
        live: null,
        policyHealth: policyHealth,
        storage: health.storage || {}
      };

      paintLangSwitcher(langs.items);
      applyStatic();
      updateAuthButtons();
      var preview = AppCloud.preview();
      $('cloudNotice').textContent = preview ? t(preview) : signedInUserId ? t('auth.signedIn') : '';
      if (!STATE.cloudInitialized) { initCloud(); STATE.cloudInitialized = true; }

      var sel = $('nat');
      var keep = sel.value;
      sel.innerHTML = countries.items
        .map(function (c) { return '<option value="' + esc(c.code) + '">' + esc(c.name) + '</option>'; })
        .join('');
      sel.value = keep && countries.items.some(function (c) { return c.code === keep; }) ? keep : 'DE';

      renderChips();
      renderDest(STATE.cat);
      renderQuestions();
      renderPstats();
      renderSteps();
      renderPrepStatic();
      renderNotes(STATE.view);
      loadHistory();

      renderLoadState('ready');
      setStatus(t('ui.status.connected', { version: meta.policy.version }), false);

      if (!STATE.bound) {
        bindEvents();
        STATE.bound = true;
      }
      judge();
      tax();
      refreshLive(sequence);
      if (STATE.greeted && $('chat').children.length <= 1) {
        STATE.greeted = false;
      }
    })
    .catch(function () {
      if (sequence !== loadSequence || lang !== STATE.lang) return;
      renderLoadState('failed');
    });
}

var liveFlight = null;
function refreshLive(sequence) {
  if (sequence === undefined) sequence = loadSequence;
  if (document.hidden || sequence !== loadSequence || STATE.loadState !== 'ready' || !STATE.data.dest) return Promise.resolve();
  if (liveFlight && liveFlight.sequence === sequence) return liveFlight.promise;
  var lang = STATE.lang;
  var flight = { sequence: sequence };
  liveFlight = flight;
  function current() { return sequence === loadSequence && lang === STATE.lang && STATE.loadState === 'ready'; }
  var live = api('/api/live').then(function (data) {
    if (!current()) return;
    STATE.data.live = data;
    var weather = data.weather || {};
    var byId = {};
    (weather.items || []).forEach(function (item) { byId[item.id] = item; });
    STATE.data.dest.live = weather;
    STATE.data.dest.items.forEach(function (item) { item.weather = byId[item.id] || null; });
    renderDest(STATE.cat);
    renderLivePanel();
  }).catch(function () {
    if (!current()) return;
    if (STATE.data.live) {
      ['weather', 'fx'].forEach(function (key) {
        if (STATE.data.live[key]) { STATE.data.live[key].stale = true; STATE.data.live[key].ok = false; }
      });
    }
    if (STATE.data.dest.live) { STATE.data.dest.live.stale = true; STATE.data.dest.live.ok = false; }
    renderDest(STATE.cat);
    renderLivePanel();
  });
  var health = api('/api/policy/health').then(function (data) {
    if (!current()) return;
    STATE.data.policyHealth = data;
    renderLivePanel();
  }).catch(function () { /* 监测失败不影响已加载的浏览内容。 */ });
  flight.promise = Promise.all([live, health]).finally(function () {
    if (liveFlight === flight) liveFlight = null;
  });
  return flight.promise;
}

function renderQuestions() {
  var qk = $('qk');
  if (!qk) return;
  qk.innerHTML = STATE.data.questions
    .map(function (q) {
      return '<button data-qid="' + esc(q.id) + '" data-act="ask">' + esc(q.q) + '</button>';
    })
    .join('');
}

function boot() {
  var review = new URLSearchParams(location.search).get('review') === '1';
  $('notes').hidden = !review;
  document.body.classList.toggle('review', review);
  var today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  $('shopDate').value = today;
  $('shopDate').max = today;
  $('shopAmt').value = '';

  var saved = null;
  try {
    saved = localStorage.getItem('inbound.lang');
  } catch (e) { /* ignore */ }

  var urlLang = new URLSearchParams(location.search).get('lang');
  if (urlLang) urlLang = urlLang.toLowerCase();
  var browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  STATE.lang =
    ['en', 'zh', 'ja', 'ko', 'es', 'ru'].indexOf(urlLang) >= 0 ? urlLang
      : validLang(saved) ? saved : (validLang(browser) ? browser : 'en');

  // 锚点直达：#ask / #prep / #arr / #dep
  var hash = (location.hash || '').replace('#', '');
  var demo = new URLSearchParams(location.search).get('demo');
  if (['exp', 'ask', 'prep', 'arr', 'dep'].indexOf(hash) >= 0) {
    setTimeout(function () {
      var btn = document.querySelector('.tabs button[data-v="' + hash + '"]');
      if (btn) go(hash, btn);
      // ?demo=judge：深链直接带上判定结果（分享/客服场景用）
      if (hash === 'ask' && demo === 'judge') setTimeout(showJudge, 500);
      if (hash === 'dep') {
        if (demo && /^\d+$/.test(demo)) $('shopAmt').value = demo;
        setTimeout(tax, 500);
      }
    }, 900);
  }

  $('retryLoad').addEventListener('click', function () {
    if (STATE.loadState === 'failed') loadAll();
  });
  loadAll();
  setInterval(function () { refreshLive(loadSequence); }, 5 * 60 * 1000);

  // 浮层：点空白处关闭
  $('ov').addEventListener('click', function (e) {
    if (e.target === $('ov')) ovOff();
  });
}

document.addEventListener('DOMContentLoaded', boot);
