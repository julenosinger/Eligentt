# Send Assets · Payment Route moved into Route Preview

Scope: presentation only, in `index.html`. No change to the execution engine, CCTP/Bridge Kit, LI.FI, Gateway, fees, BigInt math, approvals, signing, recovery, history or any other module.

## Baseline

- HEAD at start and end: `f79568704fa91d541bf7311aa8fda66d695fc9da` (changes are uncommitted; nothing merged or deployed).
- Working tree at start: clean.
- `vitest run` at this HEAD, before and after: 136 failed / 5,615 passed / 16 skipped (41 files failing). The failing set is identical (diffed). These failures pre-date this change.
- `node scripts/build.js`: OK, with the change included. The regenerated `public/index.html` was reverted so only `index.html` is modified.

## Audit findings (before editing)

- The Payment Route (`#sa-xroute-viz`) was shown by `saUpdateRoute()` as soon as a different destination network was selected, with a hard-coded "~2 minutes", a fixed red destination dot and an always-moving marker. It was not tied to any execution state.
- The real execution state already exists as `saUpdateXCStep(step, status, detail)` calls (burn / attest / mint), emitted by the CCTP (Bridge Kit) path and the legacy burn/attestation/mint path. LI.FI has no step model: it only shows busy labels on the Send button (Approving / Sending / Confirming) and calls `saLogTx` after the source transaction is confirmed. The Gateway engine takes its destination from `#sa-dest-chain`, which does not exist on this form.
- `tests/bridge-readiness-route-line.test.js` pins the component's `id="sa-xroute-packet"`, its `xc-travel` animation string and the "Payment Route" title markup, so the same node was moved and those strings kept.

## What changed

- The existing component was removed from the left column and placed inside Route Preview, directly under the FROM → TO block and above the ASSET row. Select Asset is now followed directly by Transfer Details. IDs are unchanged and there are no duplicates.
- It is hidden by default and takes no space. It becomes visible only when the existing engine reports real progress, and stays until a new Send Assets cross-chain operation actually starts, or the form returns to a same-chain transfer.
- It is driven by an observer layer added next to the Send code. The original functions run first and unchanged (`saUpdateXCStep`, `saExecuteCrossChain`, `saExecuteCCTPCrossChain`, `saExecuteLiFiCrossChain`, `saLogTx`, `saUpdateRoute` are wrapped, never replaced in behavior). No new timers, polling, RPC or API calls. One MutationObserver exists only while a LI.FI run is active and is disconnected when it ends.
- Each operation snapshots its own From/To network names when the Send click enters the cross-chain dispatcher, so later changes to the destination selector or Route Preview refreshes cannot rewrite a running operation. Step events are accepted only while an operation armed by the Send page is active, so Cross-Chain page transfers and late events after completion are ignored.
- The estimated-time chip is not shown: the engine provides no real estimate.

## Real states shown

CCTP (and legacy burn/attestation/mint): Burn pending / submitted, Burn confirmed on source, Awaiting Circle attestation, Attestation available, Mint submitted (and the engine's own "retrying n/3"), Completed only after the mint is confirmed on the destination. Failures reported by the engine show in red per step. Colors: blue = origin and early steps, amber = waiting or confirming, grey = not reached, green = confirmed, red = engine-reported failure. The moving marker is indeterminate and only runs while the operation is in progress; there are no percentages.

LI.FI: Approval pending, Sending transaction, Confirming on source network, then "Confirmed on source network. Delivery by LI.FI is not tracked here." (amber, never a full success) because this flow does not track the destination. If the run ended without a confirmed source transaction after reaching the wallet: "Not confirmed. Check your wallet or explorer before retrying." (no failure is claimed).

Not drawn: Circle Gateway (its destination is not taken from this form) and Send to Bank.

## Visibility rules verified (headless Chromium, wallet and Bridge Kit mocked, no funds)

Hidden on open; hidden with a cross-chain destination selected and an amount entered; hidden after clicking Send until the engine reports progress; hidden for the Bridge Kit approve step; shown from the first burn event; same-chain transfers never show it; a cancelled or rejected attempt before any execution leaves the previous result untouched; stale events after completion are ignored; going back to same-chain dismisses a finished result; a new operation replaces the previous one. One instance of each ID (no duplicated nodes or listeners).

Layout: about 98px tall (114px when the status wraps), inside the existing right column, no overflow, Light and Dark checked, desktop 1440×900 and mobile 390×844. On mobile the collapsed Route Preview card opens while a Payment Route is active (CSS `:has`). `prefers-reduced-motion` stops the marker.

## Limitations and findings

- Events carry no operation id, so they are attributed to the most recent Send Assets cross-chain operation. The UI blocks concurrent runs (button disabled), so this holds in practice.
- Pre-existing, not changed: the Bridge Status panel treats the engine's `error` status as grey (it only renders `failed` as red), so a failed mint appears grey there. The Payment Route shows it in red.
- A wallet rejection on the Bridge Kit burn is reported by the engine as an error, so it reads "Burn failed or was rejected."
- Real wallets, LI.FI quotes and Circle attestation timing were not exercised (no funds moved); the CCTP flow was driven with the same event sequence the engine emits.
