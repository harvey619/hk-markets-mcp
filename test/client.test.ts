import { test } from "node:test";
import assert from "node:assert/strict";
import { HkmaClient, toRecord, HkmaError } from "../src/client.js";

function fakeFetch(rows: unknown[], counter?: { n: number }) {
  return async () => {
    if (counter) counter.n++;
    return new Response(
      JSON.stringify({ header: { success: true, err_code: "0000" }, result: { datasize: rows.length, records: rows } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

const ROW = { end_of_date: "2026-09-16", disc_win_base_rate: 4, hibor_overnight: 2.03, hibor_fixing_1m: 2.95, cu_strongside: 7.75, cu_weakside: 7.85, closing_balance: 56167, twi: 100.4 };

test("date filtering sends choose=, without which the API silently ignores from/to", () => {
  const c = new HkmaClient();
  const withDates = c.buildUrl({ from: "2026-09-01", to: "2026-09-05" });
  assert.match(withDates, /choose=end_of_date/);
  assert.match(withDates, /from=2026-09-01/);
  assert.match(withDates, /to=2026-09-05/);
});

test("no choose= when no date range is asked for", () => {
  const url = new HkmaClient().buildUrl({ limit: 1 });
  assert.ok(!url.includes("choose="));
});

test("pagesize is clamped into the range the API accepts", () => {
  const c = new HkmaClient();
  assert.match(c.buildUrl({ limit: 10_000 }), /pagesize=365/);
  assert.match(c.buildUrl({ limit: 0 }), /pagesize=1/);
});

test("a malformed date is rejected before any request is made", async () => {
  const counter = { n: 0 };
  const c = new HkmaClient({ fetchImpl: fakeFetch([ROW], counter) as unknown as typeof fetch });
  await assert.rejects(() => c.daily({ from: "16/09/2026" }), HkmaError);
  assert.equal(counter.n, 0, "must not call the API with a date it already knows is wrong");
});

test("repeat questions are served from cache, so HKMA sees one request", async () => {
  const counter = { n: 0 };
  const c = new HkmaClient({ fetchImpl: fakeFetch([ROW], counter) as unknown as typeof fetch, gapMs: 0 });
  await c.latest();
  await c.latest();
  await c.latest();
  assert.equal(counter.n, 1);
});

test("concurrent identical questions share one request", async () => {
  const counter = { n: 0 };
  const c = new HkmaClient({ fetchImpl: fakeFetch([ROW], counter) as unknown as typeof fetch, gapMs: 0 });
  await Promise.all([c.latest(), c.latest(), c.latest()]);
  assert.equal(counter.n, 1);
});

test("an expired cache entry is refetched", async () => {
  const counter = { n: 0 };
  const c = new HkmaClient({ fetchImpl: fakeFetch([ROW], counter) as unknown as typeof fetch, gapMs: 0, ttlMs: 0 });
  await c.latest();
  await c.latest();
  assert.equal(counter.n, 2);
});

test("an HTTP failure surfaces as HkmaError, not an unhandled rejection", async () => {
  const c = new HkmaClient({
    fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    gapMs: 0,
  });
  await assert.rejects(() => c.latest(), /responded 503/);
});

test("an error reported in the body is surfaced even though HTTP said 200", async () => {
  const c = new HkmaClient({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ header: { success: false, err_msg: "bad field" } }), { status: 200 })) as unknown as typeof fetch,
    gapMs: 0,
  });
  await assert.rejects(() => c.latest(), /bad field/);
});

test("one failure does not stall later requests behind it in the queue", async () => {
  let call = 0;
  const c = new HkmaClient({
    ttlMs: 0,
    gapMs: 0,
    fetchImpl: (async () => {
      call++;
      if (call === 1) throw new Error("network down");
      return new Response(JSON.stringify({ header: { success: true }, result: { records: [ROW] } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => c.latest());
  const row = await c.latest();
  assert.equal(row?.end_of_date, "2026-09-16");
});

test("missing figures become null rather than zero", () => {
  const r = toRecord({ end_of_date: "2026-09-16", hibor_overnight: "", disc_win_base_rate: "4.0" });
  assert.equal(r.hibor_overnight, null, "an unpublished fixing is not a zero one");
  assert.equal(r.disc_win_base_rate, 4, "numeric strings are still numbers");
  assert.equal(r.twi, null);
});

test("latest() returns null rather than throwing when a day has no data", async () => {
  const c = new HkmaClient({ fetchImpl: fakeFetch([]) as unknown as typeof fetch, gapMs: 0 });
  assert.equal(await c.latest("2026-09-13"), null);
});

test("half a date range is refused here rather than sent upstream", async () => {
  const counter = { n: 0 };
  const c = new HkmaClient({ fetchImpl: fakeFetch([ROW], counter) as unknown as typeof fetch, gapMs: 0 });
  await assert.rejects(() => c.daily({ from: "2026-09-01" }), /both from and to/);
  await assert.rejects(() => c.daily({ to: "2026-09-16" }), /both from and to/);
  assert.equal(counter.n, 0);
});
