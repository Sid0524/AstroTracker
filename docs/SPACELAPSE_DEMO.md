# Guided demo: SpaceLapse and Barnard's Star

A short walk-through of the SpaceLapse page (the root `index.html`), using Barnard's Star. SpaceLapse is a static page that runs in your browser. It is a different app from the Flask viewer in `app.py`.

**How this was written.** The steps come from reading the code and the README. Nobody has run this demo in a browser yet. Every step marked **Unverified** needs a browser check before you rely on it.

**Read this first.** SpaceLapse shows real SPHEREx images placed on a common sky grid. It is an exploration tool, not a discovery tool. A change on screen is a clue, not a discovery. Different wavelengths, image defects and alignment can make things look different. Exposures that overlap are not independent visits. Nothing in this demo establishes motion, variability or a detection.

## Before you start

1. Install **Python 3** (only to serve the page). Check with `python --version`.
2. Install **Git**. Check with `git --version`.
3. Install **Node.js** only if you want to run the tests in the last step.
4. You need an internet connection. The page loads fonts from Google Fonts, reads images from AWS S3, and asks CDS Sesame, VizieR and other services when you use certain controls.

## Steps

1. **Clone the repository and switch branch.**

   ```powershell
   git clone https://github.com/Sid0524/AstroTracker.git AstroTracker
   cd AstroTracker
   git switch feature/spacelapse-demo
   ```

   Skip the `git switch` line once this branch is merged into `main`.

2. **Serve the page.** There is no virtual environment and no install step. The README uses `python3 -m http.server 8000`.

   ```powershell
   python -m http.server 8000
   ```

   Open <http://localhost:8000> and leave this terminal open. Press Ctrl+C to stop it.

   - The Flask viewer also uses port 8000, so run only one of them at a time.
   - **Unverified:** the `python` command on Windows PowerShell. The README only shows `python3`.

3. **Look at the start page.** You will see a hero section with "Choose a target" and "Search the sky" buttons, and a simulated before-and-after slider labelled "Simulated example · not real sky data". The slider is a teaching aid. It does not show real SPHEREx images.

4. **Open Barnard's Star.** Scroll to **Five challenge targets** and click the **Barnard's Star** card. Its note reads "Approximate 2026 fixed center; high proper motion". The card opens a 10′ field (the "10′ Medium" button).

   - The field center stays fixed. The page says "Fixed center; verify the position at each epoch", because Barnard's Star moves across the sky.
   - **Unverified:** the card opens the workspace and starts loading with no further click.

5. **Wait for the frames to load.** The page searches its local index, then downloads image cutouts for one detector band. A progress bar shows the download. When enough frames are in, Time-lapse starts playing.

   - The page picks band D2 if it has images, or otherwise the band with the most images.
   - Read the line under the band buttons for the band's wavelength range and its number of archive images. That count comes from your local index and is not the same as the Flask viewer's count.
   - The local index may not include DR1. The README says the index is built from QR2 and QR3 and that DR1 is "pending index rebuild". Open **Archive releases & freshness** to see which releases the index actually holds, and **Archive coverage** to see dates by detector and release.
   - **Unverified:** which band is chosen, how many frames load, how long loading takes, and what the field looks like.

6. **Pick another band.** Click one of the round **D1** to **D6** buttons. A button is disabled if the band has no images. The page loads that band's frames. A different band shows a different slice of infrared light (D1 is 0.75–1.09 µm).

   - **Unverified:** the button labels and counts shown when you hover or focus a button.

7. **Play and step through time.**
   - Choose **Time-lapse**. Click **Play** to start or pause, use the **‹** and **›** buttons to step one frame, and drag the **Speed** slider (1 to 12 frames per second).
   - Click a mark on the **Observation timeline** or a thumbnail in the filmstrip to jump to a date.
   - Keyboard shortcuts work when no control is focused: the **←** and **→** keys step, and the space bar plays or pauses.
   - There is no scrubber slider for frames. The timeline marks and the filmstrip do that job.
   - **Unverified:** the playback speed, and that timeline clicks land on the right dates.

8. **Blink two dates (A and B).**
   - Click **Blink**, or press `b`. The view flips between two dates.
   - Under the timeline, a row reads "Select a date for" with **A** and **B** buttons. It appears only when at least two frames are loaded. Click **A**, then click a timeline mark or a filmstrip thumbnail. Click **B** and do the same. Shift-click also sets B.
   - The image label shows which date is on screen. Blink flips at half the speed set by **Speed**.
   - Remember that the frames are overlapping exposures, not independent visits. Different wavelengths, image quality, background and alignment can look like change. Zodiacal light is subtracted per frame and flagged pixels are hidden by default. Neither step makes a difference a detection. Use **Inspect image quality & source files** to check one visit.
   - **Unverified:** that the A and B row appears, and the default A and B dates.

9. **Optional: other views.** The view buttons also include **A/B residual**, **Difference**, **Motion trail** and **Deep stack**. They are exploratory and can mislead when wavelengths or image quality differ. Do not read a bright or dark patch as a real object.
   - **Unverified:** how each view looks for this target.

10. **Gaia DR3 markers (automatic).** Open **Adjust the image**, then set **Catalog context** to **Gaia DR3**.
    - **This query runs by itself.** There is no Query button. As soon as you change the menu, and a frame is loaded in **Time-lapse** or **Blink**, the page queries the catalog. It does not draw markers in the other views. If you open a shared link that already has Gaia selected, the query also runs by itself once the frames have loaded.
    - **Source:** the Gaia DR3 catalog, table `I/355/gaiadr3`, fetched through the **VizieR** ASU service at `vizier.cfa.harvard.edu`. The page asks for the sources nearest the field center and keeps at most 200. The search radius is set from the field size, plus a 0.05° margin.
    - Read the note under the image. It reports how many markers fall in the field and explains that positions start at J2016.0 and are moved with linear proper motion to the displayed frame's date, without parallax or radial-velocity corrections. **Catalog source details** lists up to 20 visible sources with their epochs.
    - The rings are **catalog positions, not detections**. A missing ring is not evidence of anything. The margin is not a completeness guarantee.
    - If the request fails, the note shows the error and a **Retry catalog** button appears. A failure is not the same as an empty field.
    - **Credit:** the page does not show an ESA credit line, a query date or a licence note. The Gaia data credit is ESA/Gaia/DPAC.
    - **Unverified:** that VizieR answers from your browser (it needs to allow requests from localhost), how many markers appear, and how much they move between frames.

11. **Copy the link and check it restores your selection.**
    - Click **Copy view link**. It copies the page address, which now includes the target, band, field size, view, display settings, and the exact A, B and current exposures.
    - Open the link in a new tab. **The page searches and downloads by itself. No click is needed.** This is different from the Flask viewer.
    - The page should show the same band, A and B dates and view. A note under the image should read "Shared exposure identities and display settings restored."
    - If an exposure is gone, the note says "Shared selection unavailable" and no substitute is chosen.
    - The address bar is not always up to date. Click **Copy view link** every time before you share.
    - **Unverified:** the whole round trip, including the clipboard copy and the restore note.

12. **Run the tests (optional, needs Node.js).** These run offline.

    ```powershell
    npm ci
    npm test
    ```

    The tests should finish with no failures. **Unverified** on a fresh clone.

## What this demo does not show

- It does not verify a detection, a proper motion, a variable source or a period. The README says the same.
- It does not check where Barnard's Star is on a given date. The card uses an approximate fixed 2026 center.
- A missing coverage report, a missing Gaia marker or a missing change is not evidence of anything.
