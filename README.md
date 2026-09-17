# hk-markets-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent live Hong Kong monetary data: the **HKMA Base Rate**, **HIBOR** fixings, and the **USD/HKD peg** band with the Aggregate Balance.

Data comes from the [Hong Kong Monetary Authority's public Open API](https://apidocs.hkma.gov.hk/). No API key, no registration, no account.

```
> What is overnight HIBOR doing this week, and has the HKMA been defending the peg?

  get_hibor { history_days: 5 }
  get_peg_status {}

  Overnight HIBOR is 2.03% as of 2026-09-16, having ranged 2.03% to 2.15%
  over the last five business days. The Convertibility Undertaking band is
  7.75 to 7.85 and the Aggregate Balance closed at HKD 56,167 million.
```

## Install

Claude Desktop — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hk-markets": {
      "command": "npx",
      "args": ["-y", "hk-markets-mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add hk-markets -- npx -y hk-markets-mcp
```

Anything else that speaks MCP over stdio: run `npx -y hk-markets-mcp`.

## Tools

Each declares an input **and** an output schema, so results come back as structured data rather than prose a client has to parse back out.

### `get_base_rate`

The HKMA Base Rate: the floor of the Discount Window and the anchor for Hong Kong dollar rates. Under the Linked Exchange Rate System it tracks the US federal funds target, so it usually moves only when the Fed moves.

| Argument | Type | |
|---|---|---|
| `date` | `YYYY-MM-DD`, optional | Business day to report. Omit for the latest. |

Returns `as_of`, `base_rate_percent`, `source`.

### `get_hibor`

Hong Kong Interbank Offered Rate. This dataset publishes **two tenors, overnight and one month**; other tenors are not in it.

| Argument | Type | |
|---|---|---|
| `date` | `YYYY-MM-DD`, optional | Business day to report. |
| `history_days` | `1`–`365`, optional | Also return that many recent business days, newest first. |

Returns `as_of`, `overnight_percent`, `one_month_percent`, optional `history[]`, `source`.

History is where HIBOR is actually informative: overnight can swing several points around month and quarter ends.

### `get_peg_status`

Where the Linked Exchange Rate System stands.

| Argument | Type | |
|---|---|---|
| `date` | `YYYY-MM-DD`, optional | Business day to report. |

Returns `as_of`, `strong_side`, `weak_side`, `aggregate_balance_hkd_millions`, `trade_weighted_index`, `note`, `source`.

**This dataset does not publish the spot USD/HKD rate**, so the tool reports the band the HKMA commits to trade at, plus the Aggregate Balance — which is the better intervention signal anyway. It shrinks when the HKMA buys Hong Kong dollars to defend the weak-side Convertibility Undertaking.

## Being a good guest

This is a free public service run by a central bank, so the client:

- **caches** for 15 minutes, since the data is daily — an agent asking the same question ten times costs HKMA one request;
- **shares in-flight requests**, so ten concurrent callers also make one;
- **serialises** upstream calls with a minimum 250 ms gap;
- sends a **descriptive User-Agent** pointing back here;
- **times out** at 15 seconds rather than hanging.

## Two API details worth knowing

Both are handled here, and both bite if you call the API directly:

1. **`from` and `to` are silently ignored without `choose`.** The filter only applies when `choose=<field>` names the column. Without it you get the most recent page and no error — real data for the wrong dates.
2. **Once `choose` is set, both bounds are required.** Half a range is rejected upstream; this client rejects it before the request goes out, with a message that says so.

HKMA publishes on business days, so weekends and Hong Kong public holidays have no rows. Every tool reports the `as_of` date it actually got, rather than letting an agent present Friday's figures as today's.

## Development

```bash
npm install
npm test        # 22 tests, no network: the HTTP layer is faked
npm run build
npm run dev     # run the server on stdio
```

## Licence

MIT © Harvey Singh
