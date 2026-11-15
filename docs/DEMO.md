# Guided demo: Barnard's Star

A short walk-through of the Flask sky viewer, using Barnard's Star. It takes about 15 minutes, plus download time for the first search.

Read this first: the viewer shows calibrated SPHEREx images placed on a common sky grid. It is an exploration tool, not a discovery tool. Overlapping exposures are not independent visits. Differences in wavelength, PSF, background, quality flags and astrometry can look like change. A marker or a missing marker is not evidence of anything. Inspect any apparent change manually and independently.

## Before you start

1. Install **Python 3.12 or newer**. Check with `python --version`.
2. Install **Node.js** (version 22 is what CI uses). Check with `node --version`.
3. Install **Git**. Check with `git --version`.
4. Open **Windows PowerShell** in a folder where you keep projects.

## Steps

1. **Clone the repository and switch to the branch with the viewer changes.**

   ```powershell
   git clone https://github.com/Sid0524/AstroTracker.git AstroTracker
   cd AstroTracker
   git switch feature/discovery-links
   ```

   Use the repository URL your team gave you. Once the branch is merged into `main`, you can skip the `git switch` line.

2. **Create the Python virtual environment** (the same commands as the README).

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

3. **Install the Node.js dependencies** (only the test library, jsdom).

   ```powershell
   npm install
   ```

   If you prefer a clean install that matches the lock file exactly, run `npm ci` instead.

4. **Start the server** and leave this terminal open.

   ```powershell
   .\.venv\Scripts\python.exe app.py
   ```

   Open <http://127.0.0.1:8000> in your browser. The server only listens on this computer. Press Ctrl+C in the terminal to stop it.

5. **Search Barnard's Star.** The form starts on Barnard's Star by default. To set it by hand, enter RA `269.446268` and Dec `4.768204`, choose **3 arcmin**, and leave **Data release** on **DR1 + QR3**. Click **Search this field**.

   The search asks IRSA for metadata only, so no images are downloaded yet. When we checked on 2026-11-14, the search returned about **380 overlapping exposures**. IRSA's archive can change, so your count may differ. The timeline and the observation log show the dates and detectors.

   Read the status line and any warnings. If a release failed, the viewer says its coverage is unknown. It never reports a failure as "no coverage".

6. **Pick a detector band and two exposures, then click Load selected.**
   - Choose a detector in **Detector band** (D1 is the shortest wavelength band). Each comparison uses one detector only.
   - Click **Pick first + last date** to select one exposure from the first date and one from the last date. Or tick any rows in the observation log yourself.
   - Click **Load selected**. Only the selected exposures are downloaded, a few at a time. Each cutout is one exposure, not a full image.

7. **Blink A/B and step through the frames.**
   - In the observation log, click **A** on one loaded frame and **B** on another. Clicking A or B pins that loaded frame for the blink, so the frames must be loaded first (step 6).
   - Set the playback menu to **Blink A/B** and click **Play**. Use the **←** and **→** buttons to step through frames by hand.
   - Use the time slider to move through the dates.
   - Remember that these are overlapping exposures, not independent visits. Check the frame details under the image for the wavelength, coverage and flag fraction. Some pixels can look bright or dark because of the detector, the background or the quality flags, not the sky. The viewer does not subtract zodiacal light and does not apply flag masks.

8. **Optional: turn on the Gaia DR3 overlay.**
   - Tick **Gaia DR3 overlay** under the image. Nothing is queried yet.
   - Click **Query Gaia**. The viewer asks the VizieR service for Gaia DR3 sources in the field.
   - Read the provenance line under the legend: it names the catalog (`I/355/gaiadr3`), the service (VizieR ASU), the query date, and the epoch the positions were propagated to.
   - The rings are **catalog positions**, not detections. Dashed rings are sources without proper motion, shown at their J2016.0 positions. A status of "Capped at 50" means only the 50 nearest sources are shown. A failed query is reported as "Query failed, Gaia not checked", and **Retry** sends it again.
   - Rings move only slightly between frames. Barnard's Star has a large proper motion, so its marker shifts by about one or two SPHEREx pixels over a year. Other stars move by different amounts depending on their own motion.
   - Turning the overlay on does not query by itself, and a new search does not query again.

9. **Copy the link and check that the selection is restored.**
   - After loading, the address bar contains the search parameters, the detector band (`band=D1`) and the selected exposures (`select=…`). Copy the address-bar link.
   - Open the link in a new browser tab. The form is filled in and the status line says the link includes selected exposures. **No downloads start on their own.**
   - Click **Search this field**. The same detector and rows should be selected, and the status reads "Restored N linked exposures." Click **Load selected** to fetch them.
   - If the number restored is lower than the number in the link, the exposures are no longer in the search results. This is not an error. The viewer ignores them.

10. **Run the tests.** These run offline and do not contact IRSA, VizieR or S3.

    ```powershell
    npm test
    npm run test:viewer
    .\.venv\Scripts\python.exe -m unittest -q
    ```

    All three should finish with no failures.

## What this demo does not show

- It does not verify a detection, a proper motion, a variable source or a period. The README says the same.
- It does not check the position of Barnard's Star. The sample coordinates are an approximate 2026 center, as the README states.
- Missing coverage, a missing Gaia match or a missing marker is not evidence of anything.
