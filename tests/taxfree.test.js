'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calc, calcRequest, WINDOW_DAYS } = require('../server/taxfree');
const NOW = new Date('2026-11-16T08:00:00Z');

function invalid(field) {
  return (err) => err.name === 'ValidationError' && err.field === field && err.status === 400;
}

test('默认普通口岸路线保留旧调用接口，购物日至离境90日含截止日', () => {
  assert.equal(WINDOW_DAYS, 90);
  const result = calc('2026-08-18', NOW);
  assert.equal(result.route, 'port');
  assert.equal(result.deadline, '2026-11-16');
  assert.equal(result.daysLeft, 0);
  assert.equal(result.status, 'critical');
  assert.equal(result.windowDays, 90);
  assert.equal(result.routes.find((r) => r.id === 'port').windowDays, 90);
  assert.equal(result.eligibilityConfirmed, false);
  assert.equal(calc('2026-08-17', NOW).status, 'expired');
});

test('北京时间自然日跨界，不依赖主机本地时区', () => {
  const before = calc('2026-11-16', new Date('2026-11-16T15:59:59Z'));
  const after = calc('2026-11-16', new Date('2026-11-16T16:00:00Z'));
  assert.equal(before.daysLeft, 90);
  assert.equal(after.daysLeft, 89);
  assert.doesNotThrow(() => calc('2026-11-17', new Date('2026-11-16T16:00:00Z')));
});

test('购物日期严格校验，不接受不存在日期或未来日期', () => {
  for (const date of ['2026-02-29', '2026-13-01', '2026-1-01', '2026-11-17', null, ['2026-11-16']]) {
    assert.throws(() => calc(date, NOW), invalid('shoppingDate'));
  }
  assert.doesNotThrow(() => calc('2024-02-29', NOW));
  assert.throws(() => calcRequest({ route: 'other', shoppingDate: '2026-11-16' }, NOW), invalid('route'));
});

test('即买即退仅提供28日窗口，不从购物日期自动制造截止日', () => {
  const result = calc('2026-11-16', NOW, null, { route: 'instant' });
  assert.equal(result.windowDays, 28);
  assert.equal(result.status, 'needs_agreement');
  assert.equal(result.deadline, null);
  assert.equal(result.daysLeft, null);
  assert.equal(result.noticeKey, 'dep.notice.needsAgreement');
  assert.equal(result.eligibilityConfirmed, false);
});

test('即买即退仅有协议签署日期仍不自动推算协议截止日', () => {
  const result = calcRequest({ shoppingDate: '2026-11-10', route: 'instant', agreementDate: '2026-11-11' }, NOW);
  assert.equal(result.agreementDate, '2026-11-11');
  assert.equal(result.deadline, null);
  assert.equal(result.status, 'needs_agreement');
});

test('实际协议截止日仅作为所填时间提醒，不冒称资格已确认', () => {
  const body = { route: 'instant', shoppingDate: '2026-11-01', agreementDate: '2026-11-02', agreementDeadline: '2026-11-20' };
  const result = calcRequest(body, NOW);
  assert.equal(result.deadline, '2026-11-20');
  assert.equal(result.daysLeft, 4);
  assert.equal(result.status, 'critical');
  assert.equal(result.deadlineBasis, 'user_supplied_agreement');
  assert.equal(result.noticeKey, 'dep.notice.agreementReminder');
  assert.equal(result.eligibilityConfirmed, false);
  assert.equal(calcRequest({ ...body, agreementDeadline: '2026-11-15' }, NOW).status, 'expired');
  assert.throws(() => calcRequest({ ...body, agreementDate: '2026-11-17' }, NOW), invalid('agreementDate'));
  assert.throws(() => calcRequest({ ...body, agreementDeadline: '2026-10-30' }, NOW), invalid('agreementDeadline'));
});
