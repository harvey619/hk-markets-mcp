/**
 * Client for the Hong Kong Monetary Authority's public Open API.
 *
 * No key and no registration: https://apidocs.hkma.gov.hk/. Everything this server
 * exposes comes from one dataset, "Daily Figures of Interbank Liquidity", which carries
 * the HKMA Base Rate, the two published HIBOR fixings, the Convertibility Undertaking
 * levels and the Aggregate Balance.
 *
 * Two things this module exists to get right:
 *
 * 1. Date filtering. `?from=&to=` alone is silently IGNORED by the API: it returns the
 *    most recent page instead of an error, so a caller that trusts it gets real data for
 *    the wrong dates. The filter only applies with `choose=<field>` naming the column,
 *    and once `choose` is set the API demands both bounds. Half a range is rejected here
 *    rather than sent, so the caller gets a useful message instead of an upstream 400.
 * 2. Being a polite guest. This is a free public service run by a central bank. Requests
 *    are serialised with a minimum gap, identical requests in flight are shared, and
 *    answers are cached, so an agent asking the same question ten times costs HKMA one
 *    request.
 */

const BASE = "https://api.hkma.gov.hk/public";
const DATASET = "market-data-and-statistics/daily-monetary-statistics/daily-figures-interbank-liquidity";

export const USER_AGENT = "hk-markets-mcp (+https://github.com/harvey619/hk-markets-mcp)";

/** Daily data; a short cache still collapses an agent's repeated questions into one call. */
const DEFAULT_TTL_MS = 15 * 60_000;
const MIN_REQUEST_GAP_MS = 250;
const REQUEST_TIMEOUT_MS = 15_000;

/** The fields this server reads. The API returns ~44 per row; the rest are not our business. */
export type DailyRecord = {
  end_of_date: string;
  /** HKMA Base Rate, the floor of the Discount Window, in percent. */
  disc_win_base_rate: number | null;
  /** Overnight HIBOR fixing, in percent. */
  hibor_overnight: number | null;
  /** One-month HIBOR fixing, in percent. */
  hibor_fixing_1m: number | null;
  /** Strong-side Convertibility Undertaking: HKMA sells HKD at this level. Normally 7.75. */
  cu_strongside: number | null;
  /** Weak-side Convertibility Undertaking: HKMA buys HKD at this level. Normally 7.85. */
  cu_weakside: number | null;
  /** Aggregate Balance at the close, in HKD millions. Falls when HKMA defends the weak side. */
  closing_balance: number | null;
  /** Trade-weighted Hong Kong dollar index. */
  twi: number | null;
};

const FIELDS: (keyof DailyRecord)[] = [
  "end_of_date",
  "disc_win_base_rate",
  "hibor_overnight",
  "hibor_fixing_1m",
  "cu_strongside",
  "cu_weakside",
  "closing_balance",
  "twi",
];

export class HkmaError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HkmaError";
  }
}

/** Runs tasks one at a time, never closer together than `gapMs`. */
class PoliteQueue {
  private last = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly gapMs: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.gapMs - (Date.now() - this.last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return task();
    });
    // Keep the chain alive even when a task rejects, or one failure stalls every later call.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type ClientOptions = {
  ttlMs?: number;
  gapMs?: number;
  fetchImpl?: typeof fetch;
};

export type Query = {
  /** Inclusive lower bound, YYYY-MM-DD. */
  from?: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  to?: string;
  /** Rows to return, newest first. */
  limit?: number;
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class HkmaClient {
  private readonly cache = new Map<string, { at: number; rows: DailyRecord[] }>();
  private readonly inflight = new Map<string, Promise<DailyRecord[]>>();
  private readonly queue: PoliteQueue;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.queue = new PoliteQueue(options.gapMs ?? MIN_REQUEST_GAP_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Builds the query string. Exposed so a test can assert the `choose=` guard is applied. */
  buildUrl(query: Query): string {
    const params = new URLSearchParams();
    params.set("fields", FIELDS.join(","));
    params.set("sortby", "end_of_date");
    params.set("sortorder", "desc");
    params.set("pagesize", String(Math.min(Math.max(query.limit ?? 1, 1), 365)));
    if (query.from || query.to) {
      // Without `choose`, the API ignores from/to and returns the latest page regardless.
      params.set("choose", "end_of_date");
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
    }
    return `${BASE}/${DATASET}?${params.toString()}`;
  }

  async daily(query: Query = {}): Promise<DailyRecord[]> {
    for (const [label, value] of [
      ["from", query.from],
      ["to", query.to],
    ] as const) {
      if (value !== undefined && !DATE_RE.test(value)) {
        throw new HkmaError(`${label} must be a date in YYYY-MM-DD form, received ${JSON.stringify(value)}`);
      }
    }
    if (Boolean(query.from) !== Boolean(query.to)) {
      throw new HkmaError("a date range needs both from and to; the HKMA API rejects half a range");
    }

    const url = this.buildUrl(query);
    const fresh = this.cache.get(url);
    if (fresh && Date.now() - fresh.at < this.ttlMs) return fresh.rows;

    // Ten agents asking at once should still be one request to a central bank.
    const pending = this.inflight.get(url);
    if (pending) return pending;

    const task = this.queue
      .run(() => this.request(url))
      .then((rows) => {
        this.cache.set(url, { at: Date.now(), rows });
        return rows;
      })
      .finally(() => this.inflight.delete(url));

    this.inflight.set(url, task);
    return task;
  }

  /** Newest published row, or null when the API has nothing for the range. */
  async latest(on?: string): Promise<DailyRecord | null> {
    const rows = await this.daily(on ? { from: on, to: on, limit: 1 } : { limit: 1 });
    return rows[0] ?? null;
  }

  private async request(url: string): Promise<DailyRecord[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new HkmaError("could not reach the HKMA API", cause);
    }
    if (!res.ok) throw new HkmaError(`the HKMA API responded ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new HkmaError("the HKMA API returned a body that is not JSON", cause);
    }

    // Shape: { header: { success, err_code, err_msg }, result: { datasize, records } }
    const header = (body as { header?: { success?: boolean; err_msg?: string } }).header;
    if (header?.success === false) {
      throw new HkmaError(`the HKMA API reported an error: ${header.err_msg ?? "no message"}`);
    }
    const records = (body as { result?: { records?: unknown } }).result?.records;
    if (!Array.isArray(records)) throw new HkmaError("the HKMA API response had no records array");
    return records.map(toRecord);
  }
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Missing values are null rather than guessed. An absent fixing is not a zero one. */
export function toRecord(raw: unknown): DailyRecord {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    end_of_date: typeof r.end_of_date === "string" ? r.end_of_date : "",
    disc_win_base_rate: num(r.disc_win_base_rate),
    hibor_overnight: num(r.hibor_overnight),
    hibor_fixing_1m: num(r.hibor_fixing_1m),
    cu_strongside: num(r.cu_strongside),
    cu_weakside: num(r.cu_weakside),
    closing_balance: num(r.closing_balance),
    twi: num(r.twi),
  };
}
