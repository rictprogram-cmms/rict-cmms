# RICT CMMS — Timestamp Conventions

Verified against live data on 2026-08-25. The app deliberately uses **two**
conventions, split by table. Both are internally consistent; the danger is
mixing them within one table. Check this list before writing or reading any
timestamp column.

## Convention A — Fake-UTC (local wall-clock stored with `+00`)

The value stored is the *local* (America/Chicago) wall-clock time, with a
`+00` offset that must be ignored. Used where the schedule is inherently
local (lab hours, punches, checkouts).

| Table | Columns | Write with | Read with |
|---|---|---|---|
| `time_clock` | `punch_in`, `punch_out`, `approved_date` | `localToUtcIso()` | `getUTCHours()` / `fakeUtcToDisplay()` |
| `asset_checkouts` | `checked_out_at`, `expected_return`, `returned_at`, `acknowledged_at` | `localToUtcIso()` | `fakeUtcToDisplay()`, `daysOverdue()` |
| `absence_requests` | `created_at`, `updated_at`, `review_date`, `makeup_complete_date` | `localToUtcIso()` | `fakeUtcToLocalDate()` |
| `lab_signup`, `lab_calendar` | signup/slot times | `localToUtcIso()` | `getUTC*` |
| `weekly_lab_tracker` | `signed_off_at` and other sign-off times | `localToUtcIso()` | `getUTC*` |
| `glossary` | `created_at`, `updated_at` | `localToUtcIso()` | — |

Helpers live in `src/hooks/useAssetCheckouts.js` (`localToUtcIso`,
`fakeUtcToDisplay`) and `src/hooks/useTimeCards.js`.

**Never** display these with `new Date(x).toLocaleString()` — it will shift
the time by the UTC offset.

## Convention B — Real UTC (standard `timestamptz`)

Written with `new Date().toISOString()` (or the DB default `now()`),
displayed with `toLocaleString()` / `formatDate()`. Everything not listed
above, including:

`work_orders`, `work_orders_closed`, `work_order_logs`, `orders`,
`order_line_items`, `bug_tracker`, `changelog`, `sops`, `settings`,
`announcements`, `inventory`, `assets`, `pm_schedules`, `network_*`,
`profiles`, `audit_log`, `counters`, `time_entry_requests`
(`created_at`, `review_date`), `lab_signup_requests` (`submitted_date`),
`weekly_lab_tracker.created_at`.

## Date-only strings (`YYYY-MM-DD`)

Always append `T00:00:00` (no offset) before `new Date()` so they parse as
local midnight; a bare `YYYY-MM-DD` parses as UTC midnight and shifts a day
in US timezones. Use `formatDateKey()` (local) — never `toISOString()` — to
build date keys.

## How to tell which convention a column uses

Compare a recent row against `audit_log.timestamp` (real UTC) for the same
action: equal → real UTC; ~5–6 hours behind → fake-UTC. Or simply: does the
stored hour match the wall clock when it happened?
