// 站長操作紀錄：事件型別與 API 邊界的正規化（前後端共用，無副作用）

type Base = { t: number; sid: string; path: string };

export type ActivityEvent = Base &
  (
    | { type: 'session'; ua: string; vw: number; vh: number; dpr: number; standalone: boolean }
    | { type: 'nav'; from: string }
    | {
        type: 'tap';
        x: number;
        y: number;
        sy: number;
        wy: number;
        tag: string;
        name: string;
        href?: string;
        interactive: boolean;
        clicked: boolean;
      }
    | { type: 'error'; message: string; source: string }
    | { type: 'vis'; state: 'hidden' | 'visible' }
  );

export const ACTIVITY_LOG_MAX_EVENTS_PER_CALL = 100;
const DAY = 24 * 60 * 60 * 1000;

type Parser = (v: unknown) => unknown;
const str = (max: number): Parser => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num: Parser = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool: Parser = (v) => (typeof v === 'boolean' ? v : undefined);
const visState: Parser = (v) => (v === 'hidden' || v === 'visible' ? v : undefined);

// 各型別允許的欄位；未列出的欄位一律丟棄
const SCHEMAS: Record<ActivityEvent['type'], Record<string, Parser>> = {
  session: { ua: str(300), vw: num, vh: num, dpr: num, standalone: bool },
  nav: { from: str(300) },
  tap: {
    x: num,
    y: num,
    sy: num,
    wy: num,
    tag: str(16),
    name: str(40),
    href: str(200),
    interactive: bool,
    clicked: bool,
  },
  error: { message: str(300), source: str(200) },
  vis: { state: visState },
};

function normalizeOne(raw: unknown, now: number): ActivityEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const type = e.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMAS, type)) return null;

  const t = num(e.t) as number | undefined;
  const sid = str(32)(e.sid);
  const path = str(300)(e.path);
  if (t === undefined || t > now + DAY || t < now - 7 * DAY) return null;
  if (sid === undefined || path === undefined) return null;

  const out: Record<string, unknown> = { type, t, sid, path };
  for (const [field, parse] of Object.entries(SCHEMAS[type as ActivityEvent['type']])) {
    const value = parse(e[field]);
    if (value === undefined) {
      if (field === 'href') continue; // 唯一的選填欄位，不合法就略過該欄
      return null;
    }
    out[field] = value;
  }
  return out as ActivityEvent;
}

export function normalizeActivityEvents(input: unknown): ActivityEvent[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const result: ActivityEvent[] = [];
  for (const raw of input) {
    const event = normalizeOne(raw, now);
    if (event) result.push(event);
    if (result.length >= ACTIVITY_LOG_MAX_EVENTS_PER_CALL) break;
  }
  return result;
}
