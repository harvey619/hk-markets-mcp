import { test } from "node:test";
import assert from "node:assert/strict";
import { HkmaClient } from "../src/client.js";
import { createTools } from "../src/tools.js";

const ROW = { end_of_date: "2026-09-16", disc_win_base_rate: 4, hibor_overnight: 2.03, hibor_fixing_1m: 2.95, cu_strongside: 7.75, cu_weakside: 7.85, closing_balance: 56167, twi: 100.4 };

function tools(rows: unknown[] = [ROW]) {
  const client = new HkmaClient({
    gapMs: 0,
    ttlMs: 0,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ header: { success: true }, result: { records: rows } }), { status: 200 })) as unknown as typeof fetch,
  });
  return Object.fromEntries(createTools(client).map((t) => [t.name, t]));
}

test("the three tools are registered under stable names", () => {
  assert.deepEqual(Object.keys(tools()).sort(), ["get_base_rate", "get_hibor", "get_peg_status"]);
});

test("every tool declares an output schema, so results are structured not prose", () => {
  for (const t of Object.values(tools())) {
    assert.ok(t.config.outputSchema, `${t.name} has no output schema`);
    assert.ok(t.config.annotations?.readOnlyHint, `${t.name} should be marked read-only`);
  }
});

test("get_base_rate reports the rate and the day it belongs to", async () => {
  const r = await tools().get_base_rate!.handler({});
  assert.equal(r.structuredContent.base_rate_percent, 4);
  assert.equal(r.structuredContent.as_of, "2026-09-16");
  assert.match(r.content[0]!.text, /4%/);
});

test("get_hibor returns both published tenors and no history unless asked", async () => {
  const r = await tools().get_hibor!.handler({});
  assert.equal(r.structuredContent.overnight_percent, 2.03);
  assert.equal(r.structuredContent.one_month_percent, 2.95);
  assert.equal(r.structuredContent.history, undefined);
});

test("get_hibor summarises the range when history is requested", async () => {
  const rows = [ROW, { ...ROW, end_of_date: "2026-09-15", hibor_overnight: 2.11 }, { ...ROW, end_of_date: "2026-09-14", hibor_overnight: 3.4 }];
  const r = await tools(rows).get_hibor!.handler({ history_days: 3 });
  assert.equal((r.structuredContent.history as unknown[]).length, 3);
  assert.match(r.content[0]!.text, /2\.03% to 3\.4%/);
});

test("get_peg_status says plainly that spot is not in this dataset", async () => {
  const r = await tools().get_peg_status!.handler({});
  assert.equal(r.structuredContent.strong_side, 7.75);
  assert.equal(r.structuredContent.weak_side, 7.85);
  assert.equal(r.structuredContent.aggregate_balance_hkd_millions, 56167);
  assert.match(r.structuredContent.note as string, /does not publish the spot/i);
});

test("asking for a day with no figures explains why rather than returning nothing", async () => {
  await assert.rejects(
    () => tools([]).get_base_rate!.handler({ date: "2026-09-13" }),
    /business days only/,
  );
});

test("history without a specific date asks for a page, not a half range", async () => {
  const urls: string[] = [];
  const client = new HkmaClient({
    gapMs: 0,
    ttlMs: 0,
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ header: { success: true }, result: { records: [ROW] } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const tool = createTools(client).find((t) => t.name === "get_hibor")!;
  await tool.handler({ history_days: 5 });
  assert.ok(!urls.some((u) => u.includes("choose=")), "must not send a range the API will reject");
  assert.ok(urls.some((u) => u.includes("pagesize=5")));
});

test("history for a named day sends a complete range", async () => {
  const urls: string[] = [];
  const client = new HkmaClient({
    gapMs: 0,
    ttlMs: 0,
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ header: { success: true }, result: { records: [ROW] } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const tool = createTools(client).find((t) => t.name === "get_hibor")!;
  await tool.handler({ date: "2026-09-16", history_days: 5 });
  // Two calls go out: the single named day, then the window behind it. Assert on the window.
  const ranged = urls.find((u) => u.includes("choose=") && !u.includes("from=2026-09-16"))!;
  assert.ok(ranged, "a named day needs a range for its history window");
  assert.match(ranged, /from=2026-08-27/);
  assert.match(ranged, /to=2026-09-16/);
  assert.match(ranged, /pagesize=5/);
});
