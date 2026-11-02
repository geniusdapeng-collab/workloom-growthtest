# T-2026-1102-9006 post-baseline repair records

`MC-013` through `MC-022` were introduced after the frozen audit baseline
`299617d3a829157f86f470fe6a7a6cc08d64ca8e`. Their root-cause code did not
exist at that audit baseline, so the MCD validator correctly refuses to merge
them into `ledger.json` as audit-baseline evidence.

These records remain task-local post-baseline evidence. They must be covered by:

1. the final frozen-source real 14-case matrix;
2. independent acceptance of the repair commit;
3. the M6 handoff and final report, with this distinction called out.

The files are not a substitute for the audit-baseline ledger and must not be
used to claim that the original audit discovered them.
