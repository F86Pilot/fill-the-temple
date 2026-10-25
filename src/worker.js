import { DurableObject } from 'cloudflare:workers';

const TYPES = ['baptism', 'initiatory', 'endowment', 'sealCouple', 'sealChild'];
const MAX_EACH = 99;
const DEFAULT_GOAL = 300;
const MIN_GOAL = 75;            // below this the figures hit their max size and can't fill the temple

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const temple = env.TEMPLE.get(env.TEMPLE.idFromName('ward'));   // one ward, one temple

    if (url.pathname === '/api/live') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      return temple.fetch(request);
    }

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const entry = parseEntry(body);
      if (typeof entry === 'string') return json({ error: entry }, 400);
      return json(await temple.submit(entry));
    }

    if (url.pathname === '/api/totals' && request.method === 'GET') return json(await temple.totals());

    if (url.pathname.startsWith('/api/admin/')) {
      if (!(await isAdmin(request, env))) return json({ error: 'Wrong admin key' }, 401);
      if (url.pathname === '/api/admin/submissions' && request.method === 'GET') return json(await temple.list());
      if (url.pathname === '/api/admin/export.csv' && request.method === 'GET') {
        return new Response(toCsv(await temple.list()), {
          headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
            'content-disposition': `attachment; filename="temple-submissions-${new Date().toISOString().slice(0, 10)}.csv"` },
        });
      }
      if (url.pathname === '/api/admin/goal' && request.method === 'GET') return json({ goal: await temple.goal() });
      if (url.pathname === '/api/admin/goal' && request.method === 'PUT') {
        const goal = Number((await request.json().catch(() => ({}))).goal);
        if (!Number.isInteger(goal) || goal < MIN_GOAL || goal > 100000) return json({ error: `The goal has to be a whole number from ${MIN_GOAL} to 100,000.` }, 400);
        return json({ goal: await temple.setGoal(goal) });
      }
      const del = url.pathname.match(/^\/api\/admin\/submissions\/(\d+)$/);
      if (del && request.method === 'DELETE') return json(await temple.remove(Number(del[1])));
    }

    return json({ error: 'Not found' }, 404);
  },
};

// Returns a clean entry, or an error message for the phone to show.
function parseEntry(body) {
  if (!body || typeof body !== 'object') return 'Something went wrong. Please try again.';
  const entry = { name: String(body.name ?? '').trim().slice(0, 80), clientId: String(body.clientId ?? '').slice(0, 64) };
  let total = 0;
  for (const type of TYPES) {
    const n = Number(body[type] ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > MAX_EACH) return `Each number has to be between 0 and ${MAX_EACH}.`;
    entry[type] = n;
    total += n;
  }
  if (!total) return 'Add at least one ordinance first.';
  return entry;
}

// Used by the admin page's download and the Google Drive backup script.
function toCsv(rows) {
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;             // names are public input; keep spreadsheets from running them as formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = ['id', 'created_at', 'name', ...TYPES];
  return [['id', 'submitted_at', 'name', ...TYPES], ...rows.map(r => cols.map(c => r[c]))].map(r => r.map(cell).join(',')).join('\n') + '\n';
}

async function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const [a, b] = await Promise.all([given, env.ADMIN_KEY].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

// All submissions live in one SQLite-backed Durable Object, so concurrent reports can't clobber each other.
// The TV holds a WebSocket here; names are stored for organizers but never sent to it.
export class Temple extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      client_id TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      ${TYPES.map(t => `${t} INTEGER NOT NULL DEFAULT 0`).join(', ')}
    )`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value)');
    // The TV pings to check its connection is alive; answer without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  totals() {
    const row = this.sql.exec(`SELECT ${TYPES.map(t => `COALESCE(SUM(${t}), 0) AS ${t}`).join(', ')} FROM submissions`).one();
    return Object.fromEntries(TYPES.map(t => [t, row[t]]));
  }

  // The goal only changes how the TV draws the pile (smaller figures for a bigger goal); submissions are untouched.
  goal() {
    return this.sql.exec("SELECT value FROM settings WHERE key = 'goal'").toArray()[0]?.value ?? DEFAULT_GOAL;
  }

  setGoal(goal) {
    this.sql.exec("INSERT INTO settings (key, value) VALUES ('goal', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", goal);
    this.broadcast({ type: 'totals', totals: this.totals() });
    return goal;
  }

  submit(entry) {
    // A phone retrying after a dropped connection sends the same clientId; count it once.
    if (entry.clientId && this.sql.exec('SELECT 1 FROM submissions WHERE client_id = ?', entry.clientId).toArray().length) {
      return { ok: true, duplicate: true };
    }
    this.sql.exec(`INSERT INTO submissions (client_id, name, ${TYPES.join(', ')}) VALUES (?, ?, ${TYPES.map(() => '?').join(', ')})`,
      entry.clientId || null, entry.name, ...TYPES.map(t => entry[t]));
    const counts = Object.fromEntries(TYPES.map(t => [t, entry[t]]));
    this.broadcast({ type: 'submit', counts, totals: this.totals() });
    return { ok: true };
  }

  list() {
    return this.sql.exec(`SELECT id, created_at, name, ${TYPES.join(', ')} FROM submissions ORDER BY id DESC`).toArray();
  }

  remove(id) {
    const { rowsWritten } = this.sql.exec('DELETE FROM submissions WHERE id = ?', id);
    if (rowsWritten) this.broadcast({ type: 'totals', totals: this.totals() });
    return { ok: true, deleted: rowsWritten > 0 };
  }

  broadcast(msg) {
    const text = JSON.stringify({ ...msg, goal: this.goal() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch {}
    }
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'totals', totals: this.totals(), goal: this.goal() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }
}
