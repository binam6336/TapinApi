import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ipaddr from 'ipaddr.js';
import { catalog } from './public/catalog.js';

const { DATABASE_PATH, DATABASE_KEY, DASHBOARD_USER, DASHBOARD_PASSWORD } = process.env;
if (!DATABASE_PATH || !/^[a-f\d]{64}$/i.test(DATABASE_KEY ?? '') || !DASHBOARD_USER ||
    DASHBOARD_USER.includes(':') || (DASHBOARD_PASSWORD?.length ?? 0) < 12) {
  throw new Error('Set DATABASE_PATH, a 64-character hex DATABASE_KEY, DASHBOARD_USER and a DASHBOARD_PASSWORD of at least 12 characters in .env.');
}
process.umask(0o077);
const databasePath = resolve(DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY, service TEXT NOT NULL, name TEXT NOT NULL,
    data TEXT NOT NULL, UNIQUE(service, name)
  );
`);
const key = Buffer.from(DATABASE_KEY, 'hex');
const digest = value => createHash('sha256').update(value).digest();
const expectedAuth = digest(Buffer.from(DASHBOARD_USER + ':' + DASHBOARD_PASSWORD).toString('base64'));
const secureEqual = value => timingSafeEqual(expectedAuth, digest(value ?? ''));
const fields = {
  post: ['auth', 'shop_id', 'order_id', 'order_uuid', 'task_id'],
  tipax: ['auth', 'shop_id', 'order_uuid', 'hash'],
  rail: ['auth', 'shop_id', 'order_uuid', 'hash'],
  woo: ['site', 'key', 'secret']
};
const assets = new Map(Object.entries({
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/catalog.js': ['catalog.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css']
}).map(([path, [file, type]]) => [path, [readFileSync(new URL('./public/' + file, import.meta.url)), type]]));

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function seal(values) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}
function unseal(data) {
  const bytes = Buffer.from(data, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
}
function stored(service, id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'شناسه اتصال نامعتبر است.');
  const row = db.prepare('SELECT * FROM profiles WHERE service = ? AND id = ?').get(service, id);
  if (!row) throw new AppError(404, 'اتصال ذخیره‌شده پیدا نشد.');
  return row;
}
function connection(service, input) {
  const values = input.profileId == null ? {} : unseal(stored(service, input.profileId).data);
  for (const name of fields[service]) {
    const value = input.values?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) {
      throw new AppError(400, 'مقدار یکی از فیلدهای اتصال نامعتبر است.');
    }
    values[name] = value.trim();
  }
  return values;
}
function storeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port) {
      return url.href.replace(/\/+$/, '');
    }
  } catch {}
  throw new AppError(400, 'آدرس HTTPS فروشگاه را بدون پورت، رمز یا پارامتر وارد کنید.');
}
function wooCredentials(values) {
  const site = storeUrl(values.site);
  if (!values.key || !values.secret || values.key.includes(':')) {
    throw new AppError(400, 'کلید و رمز ووکامرس را وارد کنید.');
  }
  return site;
}
async function publicAddress(host) {
  const records = await lookup(host.replace(/^\[|\]$/g, ''), { all: true });
  if (!records.length || records.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new AppError(400, 'آدرس فروشگاه باید به یک مقصد عمومی اشاره کند.');
  }
  return records[0];
}
async function upstream(url, { method = 'GET', auth, body } = {}) {
  const address = await publicAddress(new URL(url).hostname);
  const headers = { Accept: 'application/json, text/html', 'Accept-Encoding': 'identity' };
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Promise((resolveRequest, reject) => {
    const outgoing = httpsRequest(url, {
      method, headers, family: address.family, signal: AbortSignal.timeout(20000),
      lookup: (_host, options, callback) => options.all
        ? callback(null, [address])
        : callback(null, address.address, address.family)
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          outgoing.destroy(new AppError(502, 'پاسخ سرویس بیش از حد بزرگ است.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolveRequest({
        status: response.statusCode, body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function replaceBody(value, values, numeric) {
  if (Array.isArray(value)) return value.map(item => replaceBody(item, values, numeric));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceBody(item, values, numeric)]));
  }
  if (typeof value !== 'string') return value;
  const exact = /^\{\{(\w+)\}\}$/.exec(value);
  const substitute = name => name !== 'auth' && Object.hasOwn(values, name) ? values[name] : '';
  if (exact && numeric) {
    const replacement = substitute(exact[1]);
    if (/^-?(0|[1-9]\d*)$/.test(replacement) && Number.isSafeInteger(Number(replacement))) return Number(replacement);
  }
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => substitute(name));
}
async function shipping(service, values, input) {
  const endpoint = catalog[service].find(item => item.id === input.endpoint);
  if (!endpoint) throw new AppError(404, 'مسیر تست پیدا نشد.');
  const url = endpoint.url.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const value = values[name];
    if (!value || !/^[\w=-]+$/.test(value)) throw new AppError(400, 'مقدار ' + name + ' را بررسی کنید.');
    return value;
  });
  let body;
  if (endpoint.method === 'POST') {
    try {
      body = JSON.stringify(replaceBody(JSON.parse(input.body), values, service === 'post'));
    } catch {
      throw new AppError(400, 'بدنه درخواست باید JSON معتبر باشد.');
    }
  }
  const start = performance.now();
  const result = await upstream(url, { method: endpoint.method, auth: values.auth, body });
  const data = result.status >= 200 && result.status < 300 ? parseJSON(result.body) : null;
  const entries = data?.entries;
  const first = entries?.list?.[0];
  const captured = {};
  function fill(name, value, overwrite = false) {
    if ((overwrite || !values[name]) && ['number', 'string'].includes(typeof value) && value !== '') {
      captured[name] = String(value);
    }
  }
  if (endpoint.id === 'shop_list') fill('shop_id', first?.id);
  if (service === 'post') {
    if (endpoint.id === 'register') {
      fill('order_id', entries?.order_id, true);
      fill('order_uuid', entries?.id, true);
    }
    if (endpoint.id === 'order_list') {
      fill('order_id', first?.order_id);
      fill('order_uuid', first?.id);
    }
    if (endpoint.id === 'task_list') fill('task_id', first?.id || first?.task_id);
  } else {
    if (endpoint.id === 'register') fill('order_uuid', entries?.uuid, true);
    if (endpoint.id === 'full_detail') fill('hash', (entries?.order ?? data?.order)?.hash, true);
    if (endpoint.id === 'filter') {
      fill('order_uuid', first?.uuid);
      fill('hash', service === 'tipax' ? first?.hash_raw || first?.hash : first?.hash);
    }
  }
  return { ...result, ms: Math.round(performance.now() - start), url, captured };
}

async function woo(values, input, details) {
  const site = wooCredentials(values);
  const auth = 'Basic ' + Buffer.from(values.key + ':' + values.secret).toString('base64');
  const root = site + '/wp-json/wc/v3';
  if (details) {
    const query = new URLSearchParams({
      _fields: 'environment.version,environment.wp_version,environment.php_version,environment.wp_memory_limit,security.secure_connection'
    });
    const response = await upstream(root + '/system_status?' + query, { auth });
    const data = parseJSON(response.body);
    const env = data?.environment;
    if (response.status !== 200 || !env) {
      throw new AppError(502, 'جزئیات سیستم در دسترس نیست. دسترسی کاربر به وضعیت ووکامرس را بررسی کنید. HTTP ' + response.status);
    }
    return { version: env.version, wp_version: env.wp_version, php_version: env.php_version,
      wp_memory_limit: env.wp_memory_limit, https: data.security?.secure_connection };
  }
  const limit = Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'تعداد سفارش باید بین ۱ تا ۱۰۰ باشد.');
  const endpoint = root + '/orders';
  const response = await upstream(endpoint + '?per_page=' + limit, { auth });
  const orders = parseJSON(response.body);
  if (response.status !== 200) {
    const messages = {
      401: 'کلید یا رمز را بررسی کنید. کلید باید دسترسی خواندن داشته باشد.',
      403: 'فروشگاه اجازه مشاهده سفارش‌ها را نداد.',
      404: 'مسیر سفارش‌ها پیدا نشد. آدرس نصب ووکامرس را بررسی کنید.'
    };
    throw new AppError(502, messages[response.status] ?? 'خطای فروشگاه. HTTP ' + response.status);
  }
  if (!Array.isArray(orders) || !orders.every(order => order && order.id != null)) {
    throw new AppError(502, 'پاسخ فروشگاه شامل فهرست سفارش‌ها نیست.');
  }
  let scope = 'unknown';
  try {
    const probe = await upstream(endpoint + '/batch', {
      method: 'POST', auth, body: JSON.stringify({ create: [], update: [], delete: [] })
    });
    const data = parseJSON(probe.body);
    if (probe.status === 200 && Array.isArray(data) && data.length === 0) scope = 'write';
    const message = String(data?.message ?? '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
    if (probe.status === 401 && data?.code === 'woocommerce_rest_authentication_error' &&
        (/does not have write permissions/i.test(message) || (/نوشتن|نوشتاری|نگارش/.test(message) && /ندارد|نیست|ندارید/.test(message)))) {
      scope = 'read';
    }
  } catch {
    // A failed permission probe does not discard the orders already retrieved.
  }
  return { scope, host: new URL(site).host, orders: orders.map(order => ({
    number: order.number ?? order.id, status: order.status, total: order.total, currency: order.currency,
    date: order.date_created, payment: order.payment_method_title,
    name: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' '),
    email: order.billing?.email, phone: order.billing?.phone
  })) };
}
async function readInput(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json' ||
      req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(415, 'درخواست JSON معتبر لازم است.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 256 * 1024) throw new AppError(413, 'درخواست بیش از حد بزرگ است.');
    chunks.push(chunk);
  }
  const input = parseJSON(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'درخواست JSON نامعتبر است.');
  return input;
}
async function api(req, path) {
  const [, , service, action] = path.split('/');
  if (!Object.hasOwn(fields, service) || !action || path !== '/api/' + service + '/' + action) {
    throw new AppError(404, 'مسیر پیدا نشد.');
  }
  if (action === 'profiles' && req.method === 'GET') {
    return db.prepare('SELECT id, name FROM profiles WHERE service = ? ORDER BY name').all(service);
  }
  if (req.method !== 'POST') throw new AppError(405, 'روش درخواست نامعتبر است.');
  const input = await readInput(req);
  if (action === 'remove') {
    const profile = stored(service, input.profileId);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
    return { ok: true };
  }
  const values = connection(service, input);
  if (action === 'profiles') {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw new AppError(400, 'نام اتصال باید بین ۱ تا ۸۰ کاراکتر باشد.');
    if (service === 'woo') values.site = wooCredentials(values);
    const duplicate = db.prepare('SELECT id FROM profiles WHERE service = ? AND name = ?').get(service, name);
    if (duplicate && duplicate.id !== input.profileId) throw new AppError(409, 'این نام قبلاً استفاده شده است.');
    if (input.profileId != null) {
      db.prepare('UPDATE profiles SET name = ?, data = ? WHERE id = ?').run(name, seal(values), input.profileId);
      return { id: input.profileId, name };
    }
    const result = db.prepare('INSERT INTO profiles (service, name, data) VALUES (?, ?, ?)').run(service, name, seal(values));
    return { id: Number(result.lastInsertRowid), name };
  }
  if (action === 'run') return service === 'woo' ? woo(values, input, false) : shipping(service, values, input);
  if (action === 'details' && service === 'woo') return woo(values, input, true);
  throw new AppError(404, 'مسیر پیدا نشد.');
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const auth = /^Basic (\S+)$/i.exec(req.headers.authorization ?? '');
  if (!secureEqual(auth?.[1])) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Tapin API", charset="UTF-8"');
    return json(res, 401, { error: 'نام کاربری و رمز داشبورد را وارد کنید.' });
  }
  const path = req.url.split('?')[0];
  try {
    if (path.startsWith('/api/')) return json(res, 200, await api(req, path));
    const asset = assets.get(path);
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
      return res.end(asset[0]);
    }
    return json(res, 404, { error: 'صفحه پیدا نشد.' });
  } catch (error) {
    if (error instanceof AppError) return json(res, error.status, { error: error.message });
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return json(res, 504, { error: 'زمان پاسخ سرویس تمام شد.' });
    }
    console.error('Request failed:', error.code ?? error.name);
    return json(res, 502, { error: 'ارتباط با سرویس یا دیتابیس برقرار نشد.' });
  }
}).listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
