import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ChatEvent {
  id: string;
  ts: number;                // ms since epoch
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  kind: 'user_msg' | 'assistant' | 'read_file' | 'write_file' | 'edit_file' | 'bash' | 'grep' | 'web_search' | 'screenshot' | 'other';
  model: string | null;
  inTokens: number;
  outTokens: number;
  label: string;
  detail?: string;
}

export interface ReaderStatus {
  source: 'sqlite' | 'json' | 'mock';
  path: string | null;
  lastPollAt: number;
  ok: boolean;
  message?: string;
}

/**
 * Candidate locations where Cursor / VS Code persist AI chat history.
 *
 * Cursor stores chat in a SQLite DB at
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb   (macOS)
 *   %APPDATA%/Cursor/User/globalStorage/state.vscdb                        (Windows)
 *   ~/.config/Cursor/User/globalStorage/state.vscdb                        (Linux)
 * inside the key ItemTable/cursorDiskKV. Schemas have shifted between
 * Cursor versions, so we probe for rows containing token counts.
 */
export function candidateLogPaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  const candidates = ['Cursor', 'Code', 'Code - Insiders'];
  if (process.platform === 'darwin') {
    for (const p of candidates) paths.push(path.join(home, 'Library', 'Application Support', p, 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const p of candidates) paths.push(path.join(appData, p, 'User', 'globalStorage', 'state.vscdb'));
  } else {
    for (const p of candidates) paths.push(path.join(home, '.config', p, 'User', 'globalStorage', 'state.vscdb'));
  }
  return paths.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
}

/** Try to load better-sqlite3. Extension still works without it (falls back to mock). */
function tryLoadSqlite(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

export class LogReader {
  private status: ReaderStatus = { source: 'mock', path: null, lastPollAt: 0, ok: false };
  private lastRowId = 0;
  private db: any = null;
  private mockStartedAt = Date.now();

  constructor(private overridePath: string = '') {}

  connect(): ReaderStatus {
    const Sqlite = tryLoadSqlite();
    const candidates = this.overridePath ? [this.overridePath] : candidateLogPaths();
    if (!Sqlite || candidates.length === 0) {
      this.status = {
        source: 'mock', path: null, lastPollAt: Date.now(), ok: false,
        message: !Sqlite
          ? 'better-sqlite3 not loaded — falling back to demo data.'
          : 'No Cursor/VS Code chat log found. Showing demo data.',
      };
      return this.status;
    }
    for (const p of candidates) {
      try {
        this.db = new Sqlite(p, { readonly: true, fileMustExist: true });
        this.status = { source: 'sqlite', path: p, lastPollAt: Date.now(), ok: true };
        return this.status;
      } catch (err: any) {
        this.status = { source: 'mock', path: p, lastPollAt: Date.now(), ok: false, message: String(err?.message ?? err) };
      }
    }
    return this.status;
  }

  getStatus() { return this.status; }

  /** Pull new events since last poll. */
  pollNew(): ChatEvent[] {
    this.status.lastPollAt = Date.now();
    if (this.status.source === 'sqlite' && this.db) {
      try {
        return this.readFromSqlite();
      } catch (err: any) {
        this.status.message = String(err?.message ?? err);
        this.status.ok = false;
        return this.mockTick();
      }
    }
    return this.mockTick();
  }

  /**
   * Read Cursor-style chat rows. The exact table/shape has changed across versions, so
   * we look up any row in cursorDiskKV / ItemTable whose value parses as JSON and
   * contains a `tokensIn`/`tokensOut` (or similar) field. This is intentionally
   * defensive — if parsing fails, we show what we can.
   */
  private readFromSqlite(): ChatEvent[] {
    const out: ChatEvent[] = [];
    const tables: string[] = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);

    const readKV = (tableName: string, keyCol: string, valCol: string) => {
      const rows = this.db.prepare(`SELECT rowid, ${keyCol} as k, ${valCol} as v FROM ${tableName} WHERE rowid > ?`).all(this.lastRowId);
      for (const row of rows) {
        this.lastRowId = Math.max(this.lastRowId, row.rowid);
        let parsed: any;
        try { parsed = JSON.parse(typeof row.v === 'string' ? row.v : row.v?.toString?.() ?? ''); } catch { continue; }
        const evs = extractEvents(parsed, String(row.k));
        out.push(...evs);
      }
    };

    if (tables.includes('cursorDiskKV')) readKV('cursorDiskKV', 'key', 'value');
    if (tables.includes('ItemTable'))    readKV('ItemTable',   'key', 'value');

    return out;
  }

  /** Synthetic ticking data so the UI demo works without real logs. */
  private mockTick(): ChatEvent[] {
    const age = Date.now() - this.mockStartedAt;
    if (age < 1500) return [];
    this.mockStartedAt = Date.now();
    const kinds: ChatEvent['kind'][] = ['read_file', 'edit_file', 'assistant', 'bash', 'grep', 'assistant'];
    const labels: Record<string, string[]> = {
      read_file: ['src/App.tsx', 'package.json', 'lib/api.ts', 'components/Card.tsx'],
      edit_file: ['src/App.tsx', 'components/Header.tsx'],
      assistant: ['Planning the change', 'Reading related files', 'Wiring the state', 'Verifying the build'],
      bash: ['npm run dev', 'git status', 'npm test'],
      grep: ['useState', 'export default', 'className'],
    };
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const label = (labels[kind] || ['…'])[Math.floor(Math.random() * (labels[kind]?.length || 1))];
    const inTok = kind === 'assistant' ? 2000 + Math.floor(Math.random() * 20000) : 0;
    const outTok = kind === 'assistant'
      ? 100 + Math.floor(Math.random() * 500)
      : 50 + Math.floor(Math.random() * 1500);
    return [{
      id: 'mock-' + Date.now(),
      ts: Date.now(),
      sessionId: 'demo-session',
      role: kind === 'assistant' ? 'assistant' : 'tool',
      kind,
      model: 'claude-sonnet-4-5',
      inTokens: inTok,
      outTokens: outTok,
      label,
    }];
  }

  dispose() { try { this.db?.close(); } catch {} }
}

/** Try hard to coerce an unknown JSON blob from Cursor storage into ChatEvent[]. */
function extractEvents(blob: any, key: string): ChatEvent[] {
  const out: ChatEvent[] = [];
  const visit = (node: any, sid: string) => {
    if (!node || typeof node !== 'object') return;
    // heuristic: anything with tokensIn/tokensOut or usage.input_tokens/output_tokens
    const tIn = node.tokensIn ?? node.inputTokens ?? node.usage?.input_tokens ?? node.prompt_tokens;
    const tOut = node.tokensOut ?? node.outputTokens ?? node.usage?.output_tokens ?? node.completion_tokens;
    if (tIn != null || tOut != null) {
      out.push({
        id: node.id || key + '-' + out.length,
        ts: Number(node.timestamp ?? node.ts ?? Date.now()),
        sessionId: node.sessionId ?? sid,
        role: (node.role ?? 'assistant') as any,
        kind: guessKind(node),
        model: node.model ?? null,
        inTokens: Number(tIn ?? 0),
        outTokens: Number(tOut ?? 0),
        label: String(node.name ?? node.tool ?? node.content?.slice?.(0, 80) ?? 'event'),
      });
    }
    if (Array.isArray(node)) for (const c of node) visit(c, sid);
    else for (const k of Object.keys(node)) visit(node[k], sid);
  };
  visit(blob, key);
  return out;
}

function guessKind(node: any): ChatEvent['kind'] {
  const t = (node.tool ?? node.type ?? node.kind ?? '').toLowerCase();
  if (t.includes('read')) return 'read_file';
  if (t.includes('write')) return 'write_file';
  if (t.includes('edit')) return 'edit_file';
  if (t.includes('grep')) return 'grep';
  if (t.includes('bash') || t.includes('shell') || t.includes('terminal')) return 'bash';
  if (t.includes('search') || t.includes('web')) return 'web_search';
  if (t.includes('screenshot')) return 'screenshot';
  if (node.role === 'user' || t === 'user') return 'user_msg';
  if (node.role === 'assistant') return 'assistant';
  return 'other';
}
