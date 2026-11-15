# Rebuilding the SpaceLapse index

SpaceLapse (the app Vercel deploys) finds exposures in a static index:
`data/index.json` plus `data/tiles/*.bin`. `tools/build_index.py` builds it from
IRSA. New releases such as DR1 appear in the app only after a rebuild.

The Flask viewer (`app.py`) queries IRSA live and does not need this.

## When it runs

- **Automatically:** every Tuesday at 06:17 UTC, on `main`
  (`.github/workflows/update-index.yml`). GitHub may start it late and pauses
  schedules after 60 days without repo activity.
- **Manually:** any time, see below.

Each run is incremental: it fetches folders not yet marked complete, plus the 4
newest folders per release. It stops starting new folders after 120 minutes,
saves what finished, and leaves the rest for the next run.

## Run it manually (GitHub)

1. Open the repo on GitHub, then **Actions** → **Update SPHEREx index and tracks**.
2. Click **Run workflow**.
3. Pick the branch. The run commits the new index **to that branch**:
   - `main`: updates the deployed app (after Vercel redeploys).
   - Your feature branch: test a rebuild without touching `main`.
4. Optional **refresh** input: folders to re-fetch, separated by spaces (for
   example `dr1/2025W17_4B`), or `all` to rebuild everything.
5. Run it again if the log says folders were **deferred** (time budget) or
   **failed**. Each run continues where the last one stopped.

You need write access to the repo. The workflow uses the code from the branch
you pick, so pick a branch that has the time-budget fix (`--max-minutes`).

## Run it locally

```powershell
.\.venv\Scripts\python.exe tools\build_index.py --max-minutes 60      # incremental
.\.venv\Scripts\python.exe tools\build_index.py --limit 2             # quick trial: 2 folders
.\.venv\Scripts\python.exe tools\build_index.py --refresh dr1/2025W17_4B
.\.venv\Scripts\python.exe tools\build_index.py --refresh all          # full rebuild (hours)
```

| Option | Default | Effect |
|---|---|---|
| `--max-minutes N` | 0 (no limit) | Stop starting new folders after N minutes |
| `--workers N` | 4 | Folders fetched at once |
| `--recent N` | 4 | Always re-fetch the N newest folders per release (0 = none) |
| `--refresh ...` | none | Re-fetch these folders, or `all` |
| `--limit N` | 0 (all) | Fetch at most N folders (testing) |

It writes `data/` in place. Commit `data/` to publish.

## Check the result

- In `data/index.json`, look at:
  - `indexedCollections`: should include `spherex_dr1`.
  - `updated`: the build time.
  - `refreshProvenance.foldersFailed` and `foldersDeferred`: empty when complete.
- Run `python tools\validate_targets.py --no-head` to see per-target counts by
  detector and date for the five challenge targets.
- In the app, search a target and open **Archive releases & freshness**. The
  **Archive coverage** panel should show DR1 marks, and the DR1 caveat goes away.
- Run `python -m unittest test_build_index` to test the builder without network
  access.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Very slow, `retry` lines, `502` | IRSA TAP is slow or down. Lower `--max-minutes` and rerun later; progress is kept. |
| `CERTIFICATE_VERIFY_FAILED` (local) | Missing "SSL.com TLS RSA Root CA 2022". On Windows, open https://irsa.ipac.caltech.edu once in Edge or PowerShell. |
| Job cancelled at 180 min | The branch lacks `--max-minutes`; use a branch with the fix. |
| Release missing | The builder indexes only releases IRSA currently lists (`spherex_qrN`, `spherex_dr1`). QR2 is no longer listed; its existing entries stay until DR1 replaces them. |
