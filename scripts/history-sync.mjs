// Node 22 wrapper of scripts/history-job.js for .github/workflows/history.yml: R2 through its S3 API (AWS Signature V4, no SDK).
// env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (repository secrets, never printed); TFS ("1h,4h"); MINUTES (time
// budget, the index is saved as it goes and the next run continues). Exit code 1 when the run had errors — status.json in the
// bucket says which (the Actions log needs a GitHub sign-in to read).
import { createHash, createHmac } from 'node:crypto';
import { sync, DEFAULT_TFS } from './history-job.js';

const { R2_ACCOUNT_ID: acct, R2_ACCESS_KEY_ID: keyId, R2_SECRET_ACCESS_KEY: secret } = process.env;
if (!acct || !keyId || !secret) { console.error('::error::R2 secrets are not set (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)'); process.exit(1); }
const BUCKET = 'sigma-history', HOST = `${acct}.r2.cloudflarestorage.com`, REGION = 'auto';
const sha = b => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

async function s3(method, key, body, extra = {}) {
  const amz = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), date = amz.slice(0, 8), hash = sha(body ?? '');
  const path = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const h = { host: HOST, 'x-amz-content-sha256': hash, 'x-amz-date': amz, ...extra };
  const names = Object.keys(h).sort(), scope = `${date}/${REGION}/s3/aws4_request`;
  const canon = [method, path, '', names.map(n => `${n}:${String(h[n]).trim()}\n`).join(''), names.join(';'), hash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + secret, date), REGION), 's3'), 'aws4_request');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', k).update(toSign).digest('hex')}`;
  delete h.host;
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(`https://${HOST}${path}`, { method, headers: h, body, signal: AbortSignal.timeout(60000) });
      if (r.ok || r.status === 404 || a >= 3) return r;
    } catch (e) { if (a >= 3) throw e; }
    await new Promise(r => setTimeout(r, 1500 * (a + 1)));
  }
}
const store = {
  async get(key) {
    const r = await s3('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
  async put(key, body, { type, cache }) {
    const r = await s3('PUT', key, body, { 'content-type': type, 'cache-control': cache });
    if (!r.ok) throw new Error(`R2 PUT ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  },
};

const tfs = (process.env.TFS || DEFAULT_TFS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const minutes = +process.env.MINUTES || 320;
const st = await sync({ store, tfs, deadline: Date.now() + minutes * 6e4 });
const line = `host ${st.host || 'none'} · pairs ${st.pairs} · pool ${st.pool} · series +${st.series.added} ~${st.series.updated} =${st.series.unchanged} left ${st.series.left} failed ${st.series.failed} · ${st.files} files, ${(st.bytes / 1e6).toFixed(1)} MB written · stored ${Object.entries(st.storage).map(([t, b]) => `${t} ${(b / 1e9).toFixed(2)} GB`).join(', ')} · check ${st.check?.same ?? 0}/${st.check?.files ?? 0} months equal to Binance · ${st.requests} requests, ${st.pauses} pauses`;
console.log(`::notice title=Candle history::${line}`);
for (const h of st.hosts) console.log(`::notice title=Binance host::${h}`);
for (const e of st.errors.slice(0, 10)) console.log(`::warning title=History::${e}`);
if (st.errors.length) process.exit(1);
