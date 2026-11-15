import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLanguage, parseLanguage } from '../src/utils/language/language';

test('쿠키·서버 값은 지원 언어 코드만 대소문자 구분 없이 받는다', () => {
  assert.equal(parseLanguage('en-US'), 'en-US');
  assert.equal(parseLanguage('EN-us'), 'en-US');
  assert.equal(parseLanguage(' zh-hans '), 'zh-Hans');
  assert.equal(parseLanguage('fr-FR'), null);
  assert.equal(parseLanguage(''), null);
  assert.equal(parseLanguage(null), null);
  assert.equal(parseLanguage(undefined), null);
});

test('브라우저 언어는 우선순위대로 처음 지원하는 언어를 고른다', () => {
  assert.equal(detectLanguage(['ko-KR', 'en-US']), 'ko-KR');
  assert.equal(detectLanguage(['fr-FR', 'en-GB', 'ko']), 'en-US');
  assert.equal(detectLanguage(['ja']), 'ja-JP');
  assert.equal(detectLanguage(['uz-Cyrl-UZ']), 'uz-Latn');
  assert.equal(detectLanguage(['my']), 'my-MM');
  assert.equal(detectLanguage(['mn']), 'mn-MN');
  assert.equal(detectLanguage(['fr-FR', 'de']), null);
  assert.equal(detectLanguage([]), null);
});

test('중국어는 간체만 고르고 번체는 다음 언어로 넘긴다', () => {
  assert.equal(detectLanguage(['zh-CN']), 'zh-Hans');
  assert.equal(detectLanguage(['zh-Hans-CN']), 'zh-Hans');
  assert.equal(detectLanguage(['zh-TW', 'en-US']), 'en-US');
  assert.equal(detectLanguage(['zh-Hant-HK', 'ja-JP']), 'ja-JP');
});
