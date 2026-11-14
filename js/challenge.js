import { makeCutout } from './cutout.js';
import { waveTable, lookup } from './wave.js';
import { selectCompatibleFrames, prepareComparison } from './analysis.js';

export const CHALLENGE_GUIDES = [
  { name: "Barnard's Star", ra: 269.446268, dec: 4.768204, size: 96, band: 1,
    guide: 'Compare the earliest and latest clean visits in Blink. Look for displacement against surrounding stars; a short baseline may show little motion at 6.15 arcsec per pixel.',
    caveat: 'Approximate 2026 fixed center, not a propagated position.' },
  { name: 'Epsilon Indi B', ra: 331.04414658852124, dec: -56.78284419511611, size: 160, band: 6,
    guide: 'Explore the longer-wavelength detectors and blink separated dates. Ba and Bb are unresolved; this is the brown-dwarf companion, not Epsilon Indi A.',
    caveat: 'CDS Sesame J2000 fixed center; high proper motion can move the source away from the marker.' },
  { name: 'WISE 0855', ra: 133.7951292, dec: -7.2451472, size: 240, band: 6,
    guide: 'Start with D6 and the widest field. Check coverage and quality before blinking. This faint brown dwarf may not be visible in individual exposures.',
    caveat: 'Fixed challenge reference position, not propagated to the observing date.' },
  { name: 'RW Aurigae', ra: 76.95652603458, dec: 30.40143817389, size: 96, band: 1,
    guide: 'Click the star for a brightness plot, restrict the wavelength window, and inspect flagged or excluded visits before interpreting variability.',
    caveat: 'CDS Sesame J2000 fixed center. Wavelength and image artifacts can mimic variability.' },
  { name: 'R Draconis', ra: 248.16761083295, dec: 66.75497941722, size: 96, band: 1,
    guide: 'Explore separated dates and the brightness plot in a narrow wavelength window. Check whether enough clean measurements span a useful time baseline.',
    caveat: 'CDS Sesame J2000 fixed center; no period or brightness-change claim is made.' },
];

export function challengeGuide(target) {
  return target && !target.moving ? CHALLENGE_GUIDES.find(g =>
    Math.abs(g.ra - target.ra) < 0.0001 && Math.abs(g.dec - target.dec) < 0.0001) : null;
}

// Bounded smoke checks of real cutouts, not an astrophysical detection test.
export async function validateTarget(target, findExposures, signal) {
  const report = { target: target.name, checkedAt: new Date().toISOString(), center: [target.ra, target.dec],
    caveat: target.caveat, size: target.size, counts: {}, samples: [], comparison: null };
  const exposures = await findExposures(target.ra, target.dec, signal);
  for (const e of exposures) report.counts[e.detector] = (report.counts[e.detector] || 0) + 1;
  const band = report.counts[target.band] ? target.band : Number(Object.keys(report.counts).sort((a, b) => report.counts[b] - report.counts[a])[0]);
  report.band = band || null;
  const list = exposures.filter(e => e.detector === band);
  const byDay = [...new Map(list.map(e => [Math.floor(e.mjd), e])).values()];
  const picks = [...new Set([byDay[0], byDay[Math.floor((byDay.length - 1) / 2)], byDay.at(-1)])].filter(Boolean);
  const frames = [];
  for (const e of picks) {
    const sample = { id: e.id, url: e.url, date: e.date.toISOString() };
    try {
      const c = await makeCutout(e, target.ra, target.dec, target.size, signal);
      if (c.offImage) sample.status = 'Off image or insufficient displayed coverage';
      else {
        sample.displayCoverage = c.valid;
        sample.qualityError = c.qualityError;
        try {
          c.wave = await waveTable(e.url, signal);
          Object.assign(sample, lookup(c.wave, ...c.pix));
        } catch (error) {
          if (signal.aborted) throw error;
          sample.waveError = error.message;
        }
        const analysisError = !c.analysis || !c.wave;
        sample.status = analysisError ? 'Browsing only: quality or wavelength unavailable' : 'Cutout and metadata loaded; comparison checks still required';
        frames.push({ exposures: [e], date: e.date, mjd: e.mjd, analysisCuts: [c], analysisError });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      sample.status = 'Failed';
      sample.error = error.message;
    }
    report.samples.push(sample);
  }
  const compatible = selectCompatibleFrames(frames);
  report.compatibleSamples = compatible.length;
  if (compatible.length >= 2) {
    try {
      const result = prepareComparison(compatible, target.size);
      report.comparison = { overlap: result.overlap, background: result.background };
    } catch (error) { report.comparisonUnavailable = error.message; }
  } else report.comparisonUnavailable = 'Fewer than two sampled visits have available quality and mutually compatible approximate wavelengths.';
  report.outcome = !exposures.length ? 'No indexed coverage' : !frames.length ? 'No usable sampled cutouts' :
    report.comparison ? 'Sampled comparison checks passed; inspect the target manually' : 'Browsing available; sampled comparison unavailable';
  return report;
}
