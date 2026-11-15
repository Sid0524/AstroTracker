// Links shipped to users point at the team's repo: source, and where candidates are reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REPO = 'https://github.com/Sid0524/AstroTracker';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('UI: "Source on GitHub" opens the team repository', () => {
  assert.match(html, new RegExp(`<a href="${REPO}"[^>]*>Source on GitHub</a>`));
});

test('P1/UI: the Report button files candidates as issues in the team repository', () => {
  assert.match(app, new RegExp(`const ISSUES = '${REPO}/issues/new';`));
});

test('no shipped page or script points at another project\'s repository', () => {
  for (const [name, text] of [['index.html', html], ['js/app.js', app]]) {
    assert.doesNotMatch(text, /github\.com\/(?!Sid0524\/AstroTracker)[\w.-]+\/[\w.-]+/, name);
  }
});
