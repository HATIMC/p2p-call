'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const https     = require('https');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const selfsigned = require('selfsigned');
const { registerUser, validateSession, getUser, getAllUsers, countAvailableUsers, evictOldestAvailableUsers, touchUser, deleteExpiredUsers, deleteUser, setUserAvailable, deleteAllUsers } = require('./db/database');

const APP_ROOT = fs.existsSync(path.join(__dirname, 'public')) ? __dirname : process.cwd();

const HTTP_PORT  = parseInt(process.env.PORT      || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const CERT_DIR   = process.env.CERT_DIR || path.join(APP_ROOT, 'certs');
const CERT_FILE  = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE   = path.join(CERT_DIR, 'key.pem');

const USER_TTL_SECONDS = parseInt(process.env.USER_TTL_SECONDS || '60', 10);
const USER_TTL_MS      = USER_TTL_SECONDS > 0 ? USER_TTL_SECONDS * 1000 : 0;
const PURGE_INTERVAL_MS = USER_TTL_MS > 0
  ? Math.max(10_000, Math.min(USER_TTL_MS, parseInt(process.env.PURGE_INTERVAL_MS || '60000', 10)))
  : 0;
const PURGE_BATCH_SIZE = parseInt(process.env.PURGE_BATCH_SIZE || '500', 10);
const IS_RENDER = !!process.env.RENDER;
const ENABLE_LOCAL_HTTPS = !IS_RENDER && process.env.ENABLE_LOCAL_HTTPS !== 'false';
const MAX_USERS = parseInt(process.env.MAX_USERS || '1000', 10);
const MAX_SIGNAL_QUEUE = parseInt(process.env.MAX_SIGNAL_QUEUE || '100', 10);
const MAX_WAITERS_PER_USER = parseInt(process.env.MAX_WAITERS_PER_USER || '2', 10);
const MAX_SDP_LENGTH = parseInt(process.env.MAX_SDP_LENGTH || '20000', 10);
const MAX_CANDIDATE_LENGTH = parseInt(process.env.MAX_CANDIDATE_LENGTH || '2000', 10);
const MAX_CANDIDATES_PER_BATCH = parseInt(process.env.MAX_CANDIDATES_PER_BATCH || '25', 10);
const USERNAME_RE = /^[a-z0-9_-]{2,32}$/;
const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate', 'candidates', 'reject', 'cancel', 'hangup']);

if (USER_TTL_MS > 0) console.log(`[config] User TTL: ${USER_TTL_SECONDS}s`);
else                 console.log('[config] User TTL: disabled');

const removedOnStart = deleteAllUsers();
if (removedOnStart > 0) console.log(`[presence] cleared ${removedOnStart} user(s) on startup`);

function shutdown(signal) {
  const removed = deleteAllUsers();
  if (removed > 0) console.log(`[presence] cleared ${removed} user(s) on ${signal}`);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ── ICE server config ─────────────────────────────────────────────────────
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls:       process.env.TURN_URL,
    username:   process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
  console.log('[config] TURN enabled:', process.env.TURN_URL);
} else {
  console.log('[config] TURN disabled');
}

// ── TLS certificate ───────────────────────────────────────────────────────
// Generate once, reuse on restart. iPhone needs to trust this cert once.
function getLanIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

async function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return { cert: fs.readFileSync(CERT_FILE, 'utf8'), key: fs.readFileSync(KEY_FILE, 'utf8') };
  }
  console.log('[tls] Generating self-signed certificate…');
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const lanIPs = getLanIPs();
  const attrs  = [{ name: 'commonName', value: 'p2pcall.local' }];
  const opts   = {
    days: 825,
    extensions: [
      { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          ...lanIPs.map(ip => ({ type: 7, ip })),
      ]},
    ],
  };
  const pems = await selfsigned.generate(attrs, opts);
  fs.writeFileSync(CERT_FILE, pems.cert,    'utf8');
  fs.writeFileSync(KEY_FILE,  pems.private, 'utf8');
  console.log('[tls] Certificate saved to certs/ — trust it on iPhone once.');
  return { cert: pems.cert, key: pems.private };
}

// ── Express app ───────────────────────────────────────────────────────────
const app = express();
// Trust reverse-proxy headers (ngrok, nginx, etc.) so req.secure is true
// when the proxy has already terminated TLS. Without this, every ngrok
// request looks like plain HTTP and triggers the redirect below.
app.set('trust proxy', 1);

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(APP_ROOT, 'public')));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

// Redirect plain HTTP → HTTPS only when NOT behind a proxy that already
// handles TLS (ngrok/cloud). req.secure is true in both cases after trust proxy.
app.use((req, res, next) => {
  if (ENABLE_LOCAL_HTTPS && !req.secure && req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
    return res.redirect(301, `https://${req.hostname}:${HTTPS_PORT}${req.url}`);
  }
  next();
});

// All API responses must never be cached — polling endpoints like
// /api/signal/:username and /api/users must always return fresh data.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── Signal store ──────────────────────────────────────────────────────────
const signalStore = new Map();
const signalWaiters = new Map();
const rateBuckets = new Map();

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${clientKey(req)}`;
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    rateBuckets.set(key, bucket);
    if (bucket.count > limit) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 60_000);

function normalizeUsername(value) {
  const username = (value || '').trim().toLowerCase();
  return USERNAME_RE.test(username) ? username : '';
}

function validCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (typeof candidate.candidate !== 'string') return false;
  return candidate.candidate.length <= MAX_CANDIDATE_LENGTH;
}

function authToken(req) {
  return req.get('X-Session-Token') || '';
}

function requireSession(username, req, res) {
  if (validateSession(username, authToken(req))) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

function takeSignals(target) {
  const signals = signalStore.get(target) || [];
  signalStore.delete(target);
  return signals;
}

function wakeSignalWaiters(target) {
  const waiters = signalWaiters.get(target);
  if (!waiters) return;
  signalWaiters.delete(target);
  const signals = takeSignals(target);
  for (const waiter of waiters) {
    clearTimeout(waiter.timeout);
    waiter.res.json({ signals });
  }
}

function enqueueSignal(target, msg) {
  if (!signalStore.has(target)) signalStore.set(target, []);
  const queue = signalStore.get(target);
  queue.push(msg);
  if (queue.length > MAX_SIGNAL_QUEUE) queue.splice(0, queue.length - MAX_SIGNAL_QUEUE);
}

setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [user, msgs] of signalStore) {
    const fresh = msgs.filter(m => m.createdAt > cutoff);
    if (fresh.length === 0) signalStore.delete(user);
    else signalStore.set(user, fresh);
  }
}, 10_000);

// ── User TTL purge ────────────────────────────────────────────────────────
if (USER_TTL_MS > 0) {
  setInterval(() => {
    const removed = deleteExpiredUsers(USER_TTL_MS, PURGE_BATCH_SIZE);
    if (removed > 0) console.log(`[purge] removed ${removed} expired user(s)`);
  }, PURGE_INTERVAL_MS);
}

// ── REST API ──────────────────────────────────────────────────────────────
app.get('/config', (_req, res) => res.json({ iceServers }));

app.post('/api/register', rateLimit('register', 30, 60_000), (req, res) => {
  const { username, peerId, sessionToken } = req.body || {};
  if (countAvailableUsers(USER_TTL_MS) >= MAX_USERS && !getUser(username, USER_TTL_MS)) {
    const removed = evictOldestAvailableUsers(countAvailableUsers(USER_TTL_MS) - MAX_USERS + 1);
    if (removed > 0) console.log(`[presence] evicted ${removed} oldest user(s) for capacity`);
  }
  const result = registerUser(username, peerId, sessionToken);
  if (!result.ok) {
    const status = result.error === 'taken' ? 409 : 400;
    return res.status(status).json({ error: result.error });
  }
  res.json({ ok: true, username: result.username, peerId: result.peerId, sessionToken: result.sessionToken, ttlSeconds: USER_TTL_SECONDS });
});

app.get('/api/users', rateLimit('users-list', 120, 60_000), (_req, res) => {
  res.json({ users: getAllUsers(USER_TTL_MS) });
});

app.get('/api/users/:username', rateLimit('users-get', 240, 60_000), (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!username) return res.status(400).json({ error: 'invalid_username' });
  const user = getUser(username, USER_TTL_MS);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(user);
});

app.delete('/api/users/:username', rateLimit('users-delete', 60, 60_000), (req, res) => {
  const name = normalizeUsername(req.params.username);
  if (!name) return res.status(400).json({ error: 'invalid_username' });
  if (!requireSession(name, req, res)) return;
  if (req.query.mode === 'hide') setUserAvailable(name, false);
  else deleteUser(name);
  res.json({ ok: true });
});

app.post('/api/signal/:username', rateLimit('signal-post', 240, 60_000), (req, res) => {
  const target = normalizeUsername(req.params.username);
  const { type, from, sdp, candidate, candidates } = req.body || {};
  const sender = normalizeUsername(from);
  if (!target || !type || !sender) {
    return res.status(400).json({ error: 'target, type and from are required.' });
  }
  if (!requireSession(sender, req, res)) return;
  if (!SIGNAL_TYPES.has(type)) return res.status(400).json({ error: 'invalid_signal_type' });
  const msg = { type, from: sender, createdAt: Date.now() };
  if (sdp) {
    if (typeof sdp !== 'object' || typeof sdp.type !== 'string' || typeof sdp.sdp !== 'string' || sdp.sdp.length > MAX_SDP_LENGTH) {
      return res.status(400).json({ error: 'invalid_sdp' });
    }
    msg.sdp = sdp;
  }
  if (candidate) {
    if (!validCandidate(candidate)) return res.status(400).json({ error: 'invalid_candidate' });
    msg.candidate = candidate;
  }
  if (Array.isArray(candidates)) {
    if (candidates.length > MAX_CANDIDATES_PER_BATCH || !candidates.every(validCandidate)) {
      return res.status(400).json({ error: 'invalid_candidates' });
    }
    msg.candidates = candidates;
  }
  enqueueSignal(target, msg);
  wakeSignalWaiters(target);
  res.json({ ok: true });
});

app.get('/api/signal/:username', rateLimit('signal-get', 180, 60_000), (req, res) => {
  const target = normalizeUsername(req.params.username);
  if (!target) return res.status(400).json({ error: 'invalid_username' });
  if (!requireSession(target, req, res)) return;
  touchUser(target);
  const signals = takeSignals(target);
  if (signals.length > 0 || req.query.wait !== '1') {
    return res.json({ signals });
  }

  const waiter = {
    res,
    timeout: setTimeout(() => {
      const waiters = signalWaiters.get(target);
      if (waiters) {
        waiters.delete(waiter);
        if (waiters.size === 0) signalWaiters.delete(target);
      }
      res.json({ signals: [] });
    }, 25_000),
  };

  if (!signalWaiters.has(target)) signalWaiters.set(target, new Set());
  const waiters = signalWaiters.get(target);
  if (waiters.size >= MAX_WAITERS_PER_USER) {
    const [oldest] = waiters;
    clearTimeout(oldest.timeout);
    oldest.res.json({ signals: [] });
    waiters.delete(oldest);
  }
  waiters.add(waiter);

  req.on('close', () => {
    clearTimeout(waiter.timeout);
    const waiters = signalWaiters.get(target);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) signalWaiters.delete(target);
  });
});

// ── Start both servers ────────────────────────────────────────────────────
(async () => {
  const tlsCreds = ENABLE_LOCAL_HTTPS ? await ensureCert() : null;

  // Cert download — lets iPhone grab the cert over HTTP to trust it
  app.get('/cert', (_req, res) => {
    if (!tlsCreds) return res.status(404).send('Local certificate is disabled.');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="p2pcall.crt"');
    res.send(tlsCreds.cert);
  });

  const httpServer  = http.createServer(app);

  httpServer.listen(HTTP_PORT, () => {
    const lanIPs = getLanIPs();
    console.log('\n🚀  Secret Calling Platform\n');
    console.log(`   HTTP : http://localhost:${HTTP_PORT}`);
    if (IS_RENDER) console.log('   Render HTTPS is handled by the platform proxy.\n');
    else lanIPs.forEach(ip => console.log(`   LAN  (HTTP) : http://${ip}:${HTTP_PORT}`));
  });

  if (ENABLE_LOCAL_HTTPS && tlsCreds) {
    const httpsServer = https.createServer(tlsCreds, app);
    httpsServer.listen(HTTPS_PORT, () => {
      const lanIPs = getLanIPs();
      lanIPs.forEach(ip => {
        console.log(`   LAN  (HTTPS): https://${ip}:${HTTPS_PORT}`);
        console.log(`   Cert (iPhone): http://${ip}:${HTTP_PORT}/cert`);
      });
      console.log(`\n   iPhone setup (one-time):`);
      console.log(`   1. Open http://<mac-ip>:${HTTP_PORT}/cert in Safari and install/trust it`);
      console.log(`   2. Open https://<mac-ip>:${HTTPS_PORT} in Safari\n`);
    });
  }
})();
