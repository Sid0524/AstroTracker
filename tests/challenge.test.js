import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHALLENGE_GUIDES, challengeGuide, validateTarget } from '../js/challenge.js';

test('guide selection follows reference coordinates, never a moving target or a name-only match', () => {
  const brownDwarf = CHALLENGE_GUIDES.find(g => g.name === 'Epsilon Indi B');
  assert.equal(challengeGuide({ ra: brownDwarf.ra, dec: brownDwarf.dec }), brownDwarf);
  assert.equal(challengeGuide({ ...brownDwarf, moving: true }), null);
  assert.equal(challengeGuide({ name: brownDwarf.name, ra: 0, dec: 0 }), undefined);
});
test('target checks distinguish no indexed coverage from a passed science validation', async () => {
  const report = await validateTarget(CHALLENGE_GUIDES[0], async () => [], new AbortController().signal);
  assert.equal(report.outcome, 'No indexed coverage');
  assert.equal(report.samples.length, 0);
  assert.equal(report.comparison, null);
  assert.equal(report.compatibleSamples, 0);
});
test('catalog failures are not reported as empty coverage', async () => {
  await assert.rejects(() => validateTarget(CHALLENGE_GUIDES[0], async () => { throw new Error('archive unavailable'); },
    new AbortController().signal), /archive unavailable/);
});
