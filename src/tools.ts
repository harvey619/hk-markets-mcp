import { z } from "zod";
import { HkmaClient, type DailyRecord, DATE_RE } from "./client.js";

/**
 * The three tools. Each declares an input and an output schema, so a client gets
 * structured, typed results rather than a paragraph it has to parse back out again.
 *
 * Every tool reports the date its numbers are stamped with. HKMA publishes on business
 * days, so "today" is often yesterday, and a tool that hides that invites an agent to
 * present stale figures as current.
 */

const SOURCE = "Hong Kong Monetary Authority, Daily Figures of Interbank Liquidity (https://apidocs.hkma.gov.hk/)";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

export type ToolDefinition = {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
    outputSchema: z.ZodRawShape;
    annotations: { readOnlyHint: boolean; openWorldHint: boolean };
  };
  /**
   * Arguments arrive already validated against inputSchema by the SDK, so each handler
   * narrows them rather than re-checking. Keeping one handler signature lets the three
   * tools live in a single array.
   */
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const dateInput = z
  .string()
  .regex(DATE_RE, "expected YYYY-MM-DD")
  .optional()
  .describe("Business day to report, YYYY-MM-DD. Omit for the most recent published day.");

const asOf = z.string().describe("The business day these figures are published for, YYYY-MM-DD.");
const source = z.string().describe("Where the figures came from.");

/** `date` minus `days` calendar days, as YYYY-MM-DD. */
function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function requireRow(row: DailyRecord | null, date?: string): DailyRecord {
  if (row) return row;
  throw new Error(
    date
      ? `HKMA has no published figures for ${date}. It publishes on business days only, so weekends and Hong Kong public holidays are absent.`
      : "HKMA returned no figures at all.",
  );
}

/** Tool results carry both a sentence for a human and the structured object for a machine. */
function result(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

const pct = (v: number | null) => (v === null ? "not published" : `${v}%`);

export function createTools(client: HkmaClient): ToolDefinition[] {
  return [
    {
      name: "get_base_rate",
      config: {
        title: "HKMA Base Rate",
        description:
          "The Hong Kong Monetary Authority Base Rate: the floor of the Discount Window and the anchor for Hong Kong dollar interest rates. Under the Linked Exchange Rate System it tracks the US federal funds target, so it usually moves only when the Fed moves.",
        inputSchema: { date: dateInput },
        outputSchema: {
          as_of: asOf,
          base_rate_percent: z.number().nullable().describe("HKMA Base Rate in percent, null if unpublished."),
          source,
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async (args) => {
        const { date } = args as { date?: string };
        const row = requireRow(await client.latest(date), date);
        return result(`HKMA Base Rate is ${pct(row.disc_win_base_rate)} as of ${row.end_of_date}.`, {
          as_of: row.end_of_date,
          base_rate_percent: row.disc_win_base_rate,
          source: SOURCE,
        });
      },
    },

    {
      name: "get_hibor",
      config: {
        title: "HIBOR fixings",
        description:
          "Hong Kong Interbank Offered Rate. This dataset publishes two tenors, overnight and one month; other tenors are not in it. Optionally returns recent history, which is where HIBOR is actually informative, because overnight can swing several points around quarter and month ends.",
        inputSchema: {
          date: dateInput,
          history_days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .optional()
            .describe("Also return this many recent business days, newest first."),
        },
        outputSchema: {
          as_of: asOf,
          overnight_percent: z.number().nullable().describe("Overnight HIBOR fixing in percent."),
          one_month_percent: z.number().nullable().describe("One-month HIBOR fixing in percent."),
          history: z
            .array(
              z.object({
                date: z.string(),
                overnight_percent: z.number().nullable(),
                one_month_percent: z.number().nullable(),
              }),
            )
            .optional()
            .describe("Recent business days, newest first, present only when history_days was given."),
          source,
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async (args) => {
        const { date, history_days } = args as { date?: string; history_days?: number };
        const row = requireRow(await client.latest(date), date);
        const structured: Record<string, unknown> = {
          as_of: row.end_of_date,
          overnight_percent: row.hibor_overnight,
          one_month_percent: row.hibor_fixing_1m,
          source: SOURCE,
        };
        let text = `HIBOR as of ${row.end_of_date}: overnight ${pct(row.hibor_overnight)}, one month ${pct(row.hibor_fixing_1m)}.`;

        if (history_days) {
          // Newest-first with a page size already gives the most recent N business days.
          // Only when a specific day was asked for does this need a range, and the API
          // wants both ends of it, so walk back generously in calendar days and let the
          // page size do the trimming: five business days is never five calendar days.
          const rows = await client.daily(
            date
              ? { from: daysBefore(date, history_days * 2 + 10), to: date, limit: history_days }
              : { limit: history_days },
          );
          structured.history = rows.map((r) => ({
            date: r.end_of_date,
            overnight_percent: r.hibor_overnight,
            one_month_percent: r.hibor_fixing_1m,
          }));
          const overnight = rows.map((r) => r.hibor_overnight).filter((v): v is number => v !== null);
          if (overnight.length > 1) {
            text += ` Over the last ${overnight.length} business days overnight ranged ${Math.min(...overnight)}% to ${Math.max(...overnight)}%.`;
          }
        }
        return result(text, structured);
      },
    },

    {
      name: "get_peg_status",
      config: {
        title: "USD/HKD peg status",
        description:
          "Where the Linked Exchange Rate System stands: the Convertibility Undertaking levels the HKMA commits to trade at, and the Aggregate Balance, which is the figure that actually shows whether it has been intervening. Note this dataset does not publish the spot USD/HKD rate, so this tool reports the band and the balance rather than guessing where spot sits.",
        inputSchema: { date: dateInput },
        outputSchema: {
          as_of: asOf,
          strong_side: z.number().nullable().describe("HKMA sells HKD at this level, normally 7.75."),
          weak_side: z.number().nullable().describe("HKMA buys HKD at this level, normally 7.85."),
          aggregate_balance_hkd_millions: z
            .number()
            .nullable()
            .describe("Closing Aggregate Balance. It shrinks when the HKMA buys HKD defending the weak side."),
          trade_weighted_index: z.number().nullable().describe("Trade-weighted Hong Kong dollar index."),
          note: z.string().describe("What this dataset does and does not say."),
          source,
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: async (args) => {
        const { date } = args as { date?: string };
        const row = requireRow(await client.latest(date), date);
        const band =
          row.cu_strongside !== null && row.cu_weakside !== null
            ? `${row.cu_strongside} to ${row.cu_weakside}`
            : "not published";
        const balance =
          row.closing_balance === null ? "not published" : `HKD ${row.closing_balance.toLocaleString("en-US")} million`;
        return result(
          `As of ${row.end_of_date} the Convertibility Undertaking band is ${band} HKD per USD and the Aggregate Balance closed at ${balance}. The spot rate is not part of this dataset.`,
          {
            as_of: row.end_of_date,
            strong_side: row.cu_strongside,
            weak_side: row.cu_weakside,
            aggregate_balance_hkd_millions: row.closing_balance,
            trade_weighted_index: row.twi,
            note: "HKMA does not publish the spot USD/HKD rate in this dataset. The Aggregate Balance is the better intervention signal: it falls when the HKMA buys Hong Kong dollars to defend the weak-side Convertibility Undertaking.",
            source: SOURCE,
          },
        );
      },
    },
  ];
}
