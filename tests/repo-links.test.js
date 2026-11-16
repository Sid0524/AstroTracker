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

test('UI: the header shows a labelled GitHub link to the team repository', () => {
  const header = html.match(/<header class="top">[\s\S]*?<\/header>/)[0];
  const link = header.match(new RegExp(`<a [^>]*href="${REPO}"[^>]*>[\\s\\S]*?</a>`));
  assert.ok(link, 'header links to the repo');
  assert.match(link[0], />\s*GitHub\s*</, 'visible text label, not icon only');
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /rel="noopener"/);
  assert.match(link[0], /aria-label="[^"]*GitHub[^"]*new tab[^"]*"/);
});

test('UI: the header GitHub link glows a few times on landing, then stops; reduced motion turns it off', () => {
  const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
  const rule = css.match(/\.dock-github\s*\{[^}]*animation:\s*([\w-]+)\s+([\d.]+)s[^;]*?\s(\d+)\s*;/);
  assert.ok(rule, '.dock-github has an animation with a finite repeat count');
  assert.ok(Number(rule[3]) >= 2 && Number(rule[3]) <= 5, 'a few pulses, not forever');
  assert.match(css, new RegExp(`@keyframes ${rule[1]}\\s*\\{[\\s\\S]*?box-shadow`), 'the pulse is a glow');
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*?animation-iteration-count: 1 !important/);
});

test('UI: the hero, right under the main buttons, says the project is open source and links to the code', () => {
  const hero = html.match(/<div class="hero-copy">[\s\S]*?<figure/)[0];
  const after = hero.slice(hero.indexOf('class="hero-actions"'));
  const link = after.match(new RegExp(`<a [^>]*href="${REPO}"[^>]*>([\\s\\S]*?)</a>`));
  assert.ok(link, 'hero links to the repo after the action buttons');
  assert.match(link[1], /View the code on GitHub/);
  assert.match(after, /Open source/);
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /rel="noopener"/);
});

test('P1/UI: the Report button files candidates as issues in the team repository', () => {
  assert.match(app, new RegExp(`const ISSUES = '${REPO}/issues/new';`));
});

test('no shipped page or script points at another project\'s repository', () => {
  for (const [name, text] of [['index.html', html], ['js/app.js', app]]) {
    assert.doesNotMatch(text, /github\.com\/(?!Sid0524\/AstroTracker)[\w.-]+\/[\w.-]+/, name);
  }
});
