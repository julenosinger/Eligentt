# Reports & Analytics — Audit Report
**Date:** 2026-10-31  
**Page:** `/reports`  
**Scope:** Read-only audit — no code changed

---

## 1. What the Reports tab currently does

### Data sources used
| Source | Variable | What it stores |
|---|---|---|
| Batch/Send history | `txHistory` (localStorage `txhistory`) | Batch sends, single sends, cross-chain batches |
| Invoices | `invoiceList` (localStorage `invoices`) | Paid invoices only (`status === 'Paid'`) |
| Payment Links | `payLinks` (localStorage `payLinks`) | Paid links only (`status === 'Paid'`) |

### What it renders
- 6 KPI cards: Total Sent, Batches, Recipients Paid, Fees Paid, Avg Batch, Fees by Type
- Bar chart: Volume by Day (last 30 days)
- Transaction table: Date, Batch ID, Type, Recipients, Amount, Fee, Status, Tx Hash
- Export CSV (only `txHistory`, not invoices/links)
- Filters: Type (Batch / Bridge / Single Send / Cross-Chain / Invoice / Payment Link) + Period (7/30/90/All)
- EventBus auto-refresh on TX_HISTORY_UPDATED, INVOICE_PAID, PAYMENT_LINK_PAID

---

## 2. Data sources that EXIST but are NOT in Reports

### 2a. Swap history — `swpLocalRecord` / `_swpLocalLoad()`
- Key: `swpLocalHistory_<walletAddr>` (localStorage)
- Fields available: `txHash`, `txHashDst`, `tokenIn`, `tokenOut`, `amountIn`, `amountOut`, `chainId`, `chainIdDst`, `provider`, `type` (same-chain / cross-chain), `status` (pending / done / failed), `timestamp`, `explorerBase`
- **Not in Reports at all.** Every swap the user makes is invisible.

### 2b. Bridge history — `getBridgeHistory()` / `BRIDGE_HISTORY_KEY`
- Key: `arcpay_bridge_history` (localStorage)
- Fields available: bridge route, from/to chain, from/to amount, protocol (CCTP/LI.FI), txHash, status, timestamp
- **Not in Reports at all.** Bridge operations are invisible.

### 2c. Schedule execution history — `ScheduleEngine.getAll()` → each `sched.executionHistory[]`
- Fields available: `txHash`, `status` (confirmed / failed / delegated), `timestamp`, `amount`, `token`, `recipient`, `reason` (on failure)
- **Not in Reports.** Schedule executions only appear in `txHistory` if the schedule executor wrote to it — most don't.

### 2d. Gateway transfers — inferred from `_multiSendRoutes` and Circle API responses
- Status: pending → processing → completed
- Tx hashes: source burn tx + destination mint tx
- **Not in Reports.** Gateway operations are fully invisible.

### 2e. CSV Export is incomplete
- `exportReportCSV()` only reads `txHistory`, ignoring invoices and payment links that are in the rendered table.
- The exported CSV will be missing rows that the user can see on screen.

### 2f. Tx Hash links hardcoded to Arc explorer
- Line 31437: `'https://explorer.arc.io/tx/' + t.txHash`
- Cross-chain txs (Base, Arbitrum, Ethereum) link to the wrong explorer.
- Swap cross-chain txs have `txHashDst` (destination hash) — never shown.

### 2g. No "Received" side
- Reports only tracks outgoing operations (sends, batches, bridges).
- There is no view of incoming USDC (payment links paid by others, invoices paid by clients).
- `invoiceList` and `payLinks` are added when status === 'Paid' — the payer's address and their tx hash are missing from the detail row.

### 2h. Expanded detail row is minimal
- The collapsible detail row only shows: Tx Hash, Date, Type, Amount.
- Missing: recipient addresses, chain IDs, token, protocol, failure reason.

### 2i. Fees by Type card shows HTML in a `st-val` container
- `rpt-fees-type` uses `innerHTML` with `<span>` blocks but lives inside a `st-val` div styled for single-line numbers — text overflows and looks broken when multiple types exist.

---

## 3. Improvement plan (priority order)

### P0 — Fix CSV export (currently exports less than what's on screen)
Add `invoiceList` and `payLinks` paid entries to `exportReportCSV()`.

### P1 — Add Swap history to Reports
Read `_swpLocalLoad()`, map to the `allData` schema, add "Swap" as a filter type.
Tx Hash link uses `swapEntry.explorerBase + '/tx/' + swapEntry.txHash`.
Cross-chain swaps: show both `txHash` (source) and `txHashDst` (destination) in the detail row.

### P2 — Add Bridge history to Reports
Read `getBridgeHistory()`, map to schema, add "Bridge" filter type.
Use correct explorer per chain (not hardcoded Arc).

### P3 — Add Schedule execution history
Read `ScheduleEngine.getAll()`, iterate `sched.executionHistory[]`, flatten to one row per execution.
Show schedule name, recipient, amount, token, txHash, status, failure reason.

### P4 — Fix explorer URL per chain
Build a `_rptExplorerUrl(txHash, chainId)` helper mapping chain IDs to their explorers.

### P5 — Fix expanded detail row
Add: recipient address(es), chain (from + to for cross-chain), token, protocol/provider, failure reason.

### P6 — Fix Fees by Type card overflow
Change to a small table or `flex-direction:column` list instead of `st-val` single-line container.

### P7 — Add "Received" section
Separate tab or section showing incoming: invoices paid by clients (with client address + their tx hash), payment links paid.

---

## 4. What must NOT be changed (hard lock)
- `txHistory` write path (batch executor, send executor, cross-chain executor)
- `swpLocalRecord` / `swpLocalUpdateStatus` in the Swap tab
- `getBridgeHistory` / `saveBridgeHistory` in the Bridge tab
- `ScheduleEngine` internals
- Gateway execution flow
- Any other tab's UI or logic

All improvements are **read-only reads** from existing storage — no writes, no mutations.
