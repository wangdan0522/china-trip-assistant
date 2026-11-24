'use strict';

/**
 * IndexNow ping: proactively notify search engines that our URLs changed.
 * No account required. Uses the key file served from our own domain.
 *
 * Usage:
 *   node scripts/indexnow.js                 # submit default URLs
 *   node scripts/indexnow.js <host> [key]    # override host/key (for testing)
 *
 * Supported engines that consume IndexNow: Bing, Yandex, Seznam, Naver, Yep.
 * We ping the aggregator endpoint and Bing directly.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_HOST = 'china-trip-assistant.onrender.com';
const URLS = [
  'https://china-trip-assistant.onrender.com/',
  'https://china-trip-assistant.onrender.com/faq.html'
];
const ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow'
];

function findKey() {
  const publicDir = path.join(__dirname, '..', 'public');
  const keyFile = fs.readdirSync(publicDir).find(
    (f) => /^[0-9a-f]{32}\.txt$/.test(f)
  );
  if (!keyFile) throw new Error('No IndexNow key file found in public/');
  const key = fs.readFileSync(path.join(publicDir, keyFile), 'utf8').trim();
  return { key, keyLocation: `https://${DEFAULT_HOST}/${keyFile}` };
}

async function main() {
  const host = process.argv[2] || DEFAULT_HOST;
  const { key, keyLocation } = findKey();
  const overrideKey = process.argv[3];
  const payload = {
    host,
    key: overrideKey || key,
    keyLocation,
    urlList: URLS.map((u) => u.replace(DEFAULT_HOST, host))
  };
  console.log('IndexNow payload:', JSON.stringify(payload, null, 2));

  let ok = 0;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload)
      });
      console.log(`${endpoint} -> HTTP ${res.status} ${res.statusText}`);
      // IndexNow: 200 = accepted, 202 = queued, 400 = bad request
      if (res.status === 200 || res.status === 202) ok++;
    } catch (error) {
      console.log(`${endpoint} -> ERROR ${error.message}`);
    }
  }
  if (ok === 0) {
    console.error('IndexNow: no endpoint accepted the ping.');
    process.exitCode = 1;
  } else {
    console.log(`IndexNow: ${ok}/${ENDPOINTS.length} endpoints accepted.`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { URLS, findKey };
