'use strict';
const fs = require('fs');
const p = 'data/i18n/ja.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

// key 是 verdict 的原键（本身含点号），value 是校订后的日文
const V = {
  'v.title.hainan': '海南省 30日間ビザ免除',
  'v.why.unilateral_over': '<b>{country}</b>は確かに50か国のリストに入っています &mdash; ただしビザなし入国は<b>30日以内</b>で、あなたの予定は{days}日です。<b>超過分は認められません。</b>',
  'v.why.transit_not_met': '240時間制度は、出発地 &rarr; 中国 &rarr; <b>第三国・地域</b>という経路が条件です。<b>帰国や、来た道をそのまま引き返すだけでは、出発地と目的地が同じ国になるため &mdash; トランジットには当たりません。</b>',
  'v.why.hainan': '<b>{country}</b>の国民として、外国人の受け入れが認められた海南の港から入国する場合、<b>海南省内</b>に限り最長30日間ビザなしで滞在できます。',
  'v.p.work.type': 'ビザの種類は目的で決まります（Z 就労 / X 留学 / J 取材）',
  'v.p.mutual.compress': '30日以内 &rarr; ビザなし',
  'v.byline': 'これはエンジンの出力で、モデルの出力ではありません。根拠：国家移民管理局 2026年8月の公告。50か国のうち48か国は、制度の有効期限が 31 Dec 2026 までです。',
};
// key 用 | 分隔：第一段是 qa 的 id，后面是字段路径（数组下标用数字）
const QA = {
  'safety|a': '中国の主要都市は、街中の治安が世界的に見ても良い部類で、観光客が凶悪犯罪に巻き込まれることはまれです。実際に旅行者を困らせるのは危険ではなく &mdash; <b>詐欺</b>です。',
  'safety|li|1': '観光地の近くで「お茶」「展覧会」「ヒスイ店」に誘ってくる人には、きっぱり断ってください。これが最も多い手口です。',
  'safety|src': '根拠：中国公安部の治安指針および中国主要都市向けの旅行注意情報（2026年）。',
  'phone|li|2': '<b>現地SIM＋VPN</b>：+86の番号が持てますが、<b>VPNは出発前にインストール</b>しておく必要があります &mdash; 中国に入ってからではVPN事業者のサイトが開きません',
  'phone|src': '根拠：各通信事業者のローミング規約、およびeSIMの経路に関する2026年の独立系現地報告。&ldquo;eSIM&rdquo;というだけでは、目的のアプリが使えるとは限りません &mdash; 海外経由のものに限ります。通信が海外経由になると、AlipayやAmapなどの中国アプリが不具合を起こすことがあります。SMS用に本国のSIMは残しておいてください。',
  'language|li|0': '対応は急速に進んでいます：天壇公園には<b>60台以上のAI翻訳機</b>が導入され、頤和園では英語での来園者アンケートを実施、空港でも多言語案内が広がっています',
  'language|li|1': '<b>用意しておきたいセット</b>：翻訳アプリ（先にオフラインパックをダウンロード）＋目的地名を中国語で表示したスクリーンショット＋ホテルの中国語カード',
  'payment|tips|0': '渡航前に<b>銀行に</b>中国に滞在する予定を伝えておきましょう &mdash; 不正利用によるブロックが大幅に減ります',
  'payment|tips|1': '<b>別々の銀行のカードを2枚</b>持ち歩きましょう。<b>紐付け時はVPNをオフに</b>してください &mdash; IPの不一致はセキュリティブロックの原因になります',
  'visa|li|3': '渡航文書・一時証明書は<b>対象外</b>で、就労と留学も<b>すべてのビザ免除制度の対象外</b>です',
  'help|li|2': '中国にある自国の大使館：書類の紛失、緊急時',
  'help|src': '根拠：国家移民管理局が公表したホットライン情報（2026年）、中国公安部およびホテル業界の通達。',
};

for (const [k, v] of Object.entries(V)) {
  if (!(k in d.verdict)) throw new Error('bad verdict key: ' + k);
  d.verdict[k] = v;
}
function setF(q, path, v) {
  const parts = path.split('|');
  let cur = q;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[key] === undefined) throw new Error('bad field: ' + path);
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  const key = /^\d+$/.test(last) ? Number(last) : last;
  if (cur[key] === undefined) throw new Error('bad field: ' + path);
  cur[key] = v;
}
for (const [k, v] of Object.entries(QA)) {
  const [id, ...rest] = k.split('|');
  const q = d.qa.find((x) => x.id === id);
  if (!q) throw new Error('bad qa id: ' + id);
  setF(q, rest.join('|'), v);
}
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
console.log('patched', Object.keys(V).length, 'verdict,', Object.keys(QA).length, 'qa fields');
