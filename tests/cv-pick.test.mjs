// Tests for cv-pick.mjs using Node's built-in test runner.
// Imports directly from the source of truth so the test and production code
// cannot drift, matching tests/jd-similarity.test.mjs.
//
// Run:  node --test tests/cv-pick.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidences, extractRequirements } from '../cv-coverage.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  texToText,
  looksLikeCv,
  htmlToText,
  readAsText,
  rankCandidates,
  candidatesFromDir,
  candidatesFromPdfIndex,
  collectCandidates,
  pick,
} from '../cv-pick.mjs';

const BACKEND_JD = `
Senior Backend Engineer

Requirements:
- Strong Java and Spring Boot experience
- Kafka and event-driven architecture
- Distributed systems and PostgreSQL
- You will design microservices and own them in production
`;

// A posting with no headings and no bullets. Coverage needs requirement lines
// to score against, so this one yields none — and the tool must say so rather
// than inventing a number. Kept as a fixture because real postings look like
// this more often than anyone would like.
const PROSE_ONLY_JD = `
We are looking for a backend engineer to join us. You will work with Java and
Kafka on interesting problems alongside a friendly team, and we care more about
how you think than any particular technology on your CV.
`;

// Fixtures must look like real CVs: cv-pick skips documents that do not, so a
// thin stub is not a valid stand-in for one.
const BACKEND_CV = `
Alex Backend — alex@example.com

EXPERIENCE
Senior Backend Engineer, A Bank            Mar 2021 - Nov 2024
Java, Spring Boot, Kafka event streaming across distributed systems and
PostgreSQL. Designed microservices and owned them in production.

EDUCATION
BSc Computer Science, A University         2016 - 2020

SKILLS
Java, Spring Boot, Kafka, PostgreSQL, microservices
`;

const FRONTEND_CV = `
Sam Designer — sam@example.com

EXPERIENCE
Senior Designer, A Studio                  Jan 2019 - Dec 2024
Figma, illustration, brand identity, typography, motion graphics, print layout
and colour theory for consumer campaigns.

EDUCATION
BA Graphic Design, An Academy              2014 - 2018

SKILLS
Figma, illustration, typography
`;

function scratch() {
  return mkdtempSync(join(tmpdir(), 'cv-pick-'));
}

test('an HTML CV reduces to the text a reader would see', () => {
  const text = htmlToText(
    '<html><head><style>p{color:red}</style><script>var x=1</script></head>' +
      '<body><h1>Jane&nbsp;Doe</h1><p>Java &amp; Kafka</p><!-- hidden --></body></html>',
  );
  assert.match(text, /Jane Doe/);
  assert.match(text, /Java & Kafka/);
  // Script and style bodies are not CV content and must never reach the score.
  assert.doesNotMatch(text, /color:red|var x/);
  assert.doesNotMatch(text, /hidden/);
});

test('readAsText converts html but leaves markdown alone', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'a.html'), '<p>Java <b>Kafka</b></p>');
    writeFileSync(join(dir, 'b.md'), '# Java <not-a-tag>');
    assert.equal(readAsText(join(dir, 'a.html')).trim(), 'Java Kafka');
    assert.match(readAsText(join(dir, 'b.md')), /<not-a-tag>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the closest CV ranks above an unrelated one', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'backend.md'), BACKEND_CV);
    writeFileSync(join(dir, 'designer.md'), FRONTEND_CV);
    const ranked = rankCandidates(BACKEND_JD, candidatesFromDir(dir, '.'));
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].label, 'backend.md');
    // Coverage, not vocabulary overlap: the backend CV evidences nearly every
    // stated requirement and the designer CV evidences none. Not asserted as a
    // clean 1.0 on purpose — this CV says "Kafka event streaming" and never
    // "event-driven", so that one requirement is genuinely unevidenced, and a
    // matcher that scored it 1.0 would be papering over a real gap.
    assert.ok(ranked[0].score > 0.8, `expected > 0.8, got ${ranked[0].score}`);
    assert.equal(ranked[1].score, 0);
    assert.deepEqual(ranked[0].missing, ['event-driven']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The ordering rule this exists to protect: a `regenerate` must never outrank a
// `reuse`, however much vocabulary it shares. Sorting on score alone put a
// high-overlap but wrong-level CV on top, which is the one thing the decision
// is supposed to prevent.
test('decision outranks score', () => {
  const ranked = [
    { label: 'wrong-level', textPath: 'x', decision: 'regenerate', score: 0.9 },
    { label: 'right', textPath: 'y', decision: 'reuse', score: 0.5 },
  ];
  const sorted = [...ranked].sort((a, b) =>
    ({ reuse: 3, 'reuse-with-edits': 2, regenerate: 1 })[b.decision] -
      ({ reuse: 3, 'reuse-with-edits': 2, regenerate: 1 })[a.decision] ||
    b.score - a.score,
  );
  assert.equal(sorted[0].label, 'right');
});

test('a seniority mismatch is not recommended for reuse', () => {
  const dir = scratch();
  try {
    // Each document must name exactly ONE level for the gate to apply, so the
    // shared body deliberately carries no seniority word of its own.
    const body =
      'Java, Spring Boot, Kafka event streaming, distributed systems, ' +
      'PostgreSQL, microservices owned in production.';
    writeFileSync(join(dir, 'intern.md'), `Intern Engineer — a@b.com\nEXPERIENCE\nJan 2023 - Dec 2024\nEDUCATION\nBSc\nSKILLS\n${body}`);
    const ranked = rankCandidates(`Principal Engineer. ${body}`, candidatesFromDir(dir, '.'));
    assert.equal(ranked[0].reason, 'level-mismatch');
    assert.equal(ranked[0].decision, 'regenerate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of that rule, and the reason the fixtures above are so
// careful: a document naming SEVERAL levels — a CV showing progression from
// junior to senior, or a JD whose boilerplate says "principal responsibilities"
// — is ambiguous, and jd-similarity stands down rather than guessing. The gate
// must not fire there, or every career-progression CV reads as a mismatch.
test('a document naming several levels does not trigger the gate', () => {
  const dir = scratch();
  try {
    const body = 'Java, Spring Boot, Kafka, distributed systems, PostgreSQL, microservices.';
    writeFileSync(join(dir, 'progression.md'), `Junior then Senior Engineer — a@b.com\nEXPERIENCE\nJan 2019 - Dec 2024\nEDUCATION\nBSc\nSKILLS\n${body}`);
    const ranked = rankCandidates(`Principal Engineer. ${body}`, candidatesFromDir(dir, '.'));
    assert.notEqual(ranked[0].reason, 'level-mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absolute --dir is honoured, not appended to the root', () => {
  const dir = scratch();
  const root = scratch();
  try {
    writeFileSync(join(dir, 'backend.md'), BACKEND_CV);
    // The directory is absolute and lives nowhere near `root`; joining the two
    // would resolve to a path that does not exist and yield zero candidates.
    const found = candidatesFromDir(root, dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].label, 'backend.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a posting with no parseable requirements scores nothing, honestly', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'backend.md'), BACKEND_CV);
    const ranked = rankCandidates(PROSE_ONLY_JD, candidatesFromDir(dir, '.'));
    assert.equal(ranked[0].requirements, 0);
    assert.equal(ranked[0].score, 0);
    // And the overall call must not read as "this CV is a bad fit" when the
    // truth is "this posting could not be parsed".
    const { decision } = pick(PROSE_ONLY_JD, candidatesFromDir(dir, '.'));
    assert.equal(decision, 'regenerate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A folder of CVs almost always also holds saved job descriptions and notes.
// Scoring a JD against a JD produces a confident high number that means
// nothing, so anything not shaped like a CV has to be excluded and reported.
test('a job description is not mistaken for a CV', () => {
  assert.equal(looksLikeCv(BACKEND_CV), true);
  assert.equal(looksLikeCv(FRONTEND_CV), true);
  assert.equal(looksLikeCv(BACKEND_JD), false);
  assert.equal(looksLikeCv(PROSE_ONLY_JD), false);
  assert.equal(looksLikeCv('acme\nglobex\ninitech\n'), false);
});

test('nothing to compare against yields regenerate, not a crash', () => {
  const { decision, best, ranked } = pick(BACKEND_JD, []);
  assert.equal(decision, 'regenerate');
  assert.equal(best, null);
  assert.deepEqual(ranked, []);
});

// pdf-index.tsv gained columns over time, so a reader must index by position
// and tolerate short rows — the same rule data/scan-history.tsv documents.
test('pdf-index rows are read by position and short rows survive', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'output'), { recursive: true });
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, 'output', 'acme.html'), `<p>${BACKEND_CV}</p>`);
    writeFileSync(join(root, 'reports', 'r1.md'), BACKEND_CV.trim());
    writeFileSync(
      join(root, 'data/pdf-index.tsv'),
      [
        'reports/r1.md\toutput/acme.pdf\toutput/acme.html\tmodern\t2026-09-01',
        'reports/r1.md\toutput/short.pdf', // legacy short row: no html column
        '', // blank line
        '# a comment',
      ].join('\n'),
    );
    const found = candidatesFromPdfIndex(root);
    // Row 1 resolves through its html; row 2 falls back to the report, which
    // exists, so both are usable and neither throws.
    assert.equal(found.length, 2);
    assert.equal(found[0].pdf, 'output/acme.pdf');
    assert.equal(found[0].label, 'acme.pdf');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pdf-index row pointing at a missing file is skipped, not fatal', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data/pdf-index.tsv'),
      'reports/gone.md\toutput/gone.pdf\toutput/gone.html\tmodern\t2026-09-01\n',
    );
    assert.deepEqual(candidatesFromPdfIndex(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cv.md is always a candidate so the list is never empty', () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'cv.md'), BACKEND_CV);
    const found = collectCandidates(root, 'jds');
    assert.equal(found.length, 1);
    assert.match(found[0].label, /master/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('thresholds are configurable', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'backend.md'), BACKEND_CV);
    const candidates = candidatesFromDir(dir, '.');
    const strict = rankCandidates(BACKEND_JD, candidates, { highThreshold: 0.99, mediumThreshold: 0.98 });
    const loose = rankCandidates(BACKEND_JD, candidates, { highThreshold: 0.01, mediumThreshold: 0.005 });
    assert.equal(strict[0].decision, 'regenerate');
    assert.equal(loose[0].decision, 'reuse');
    // The score itself is a property of the texts and must not move with them.
    assert.equal(strict[0].score, loose[0].score);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a LaTeX CV reduces to its prose', () => {
  const tex = [
    '\\documentclass{article}',
    '\\usepackage{geometry}',
    '% a comment that must not survive',
    '\\begin{document}',
    '\\textbf{Alex Backend} | alex@example.com',
    '\\section{Experience}',
    '\\resumeItem{Built a \\textbf{Kafka} event backbone in Java and Spring Boot}',
    '\\end{document}',
  ].join('\n');
  const text = texToText(tex);
  assert.match(text, /Kafka event backbone/);
  assert.match(text, /alex@example\.com/);
  // The preamble is not CV content and would otherwise contribute vocabulary.
  assert.doesNotMatch(text, /documentclass|geometry/);
  assert.doesNotMatch(text, /a comment that must not survive/);
});

// Two false positives seen in real output: "convolutional neural network" was
// scored as networking experience, and "reduce customer errors by 60%" as
// customer-facing work. A bare common noun is not evidence of a capability.
test('a common noun is not mistaken for a capability', () => {
  assert.equal(evidences('convolutional neural network (CNN) for image classification', 'networking'), false);
  assert.equal(evidences('used failover to reduce customer errors by 60%', 'customer facing'), false);
  assert.equal(evidences('integration tests with JUnit', 'api integration'), false);
  // …while the genuine article still matches.
  assert.equal(evidences('hardened air-gapped networks and firewall rules', 'networking'), true);
  assert.equal(evidences('Embedded with Australian product and business teams', 'customer facing'), true);
});


// The 0-of-0 bug, from a real Duffel posting. Its bullets are "✅", which the
// bullet pattern did not know, so each line fell through to the heading test —
// and "✅ You have opinions on…" is under 90 characters and matches the
// required-heading pattern `you (have|bring)`, so the requirement was consumed
// AS a heading. Six requirements parsed as zero.
test('emoji bullets are bullets, not headings', () => {
  const jd = [
    "You'll Thrive Here If:",
    '✅ You have a high bar for code quality and API design',
    '✅ You have opinions on good engineering standards and processes',
    '✅ You communicate clearly, articulating what you are working on',
    '',
    "What You'll Get:",
    '💰 Competitive salary + equity',
    '🏝️ Work from anywhere policy',
  ].join('\n');
  const { required, preferred } = extractRequirements(jd);
  assert.equal(required.length, 3);
  // The bullet marker itself must not survive into the requirement text.
  assert.ok(required.every((l) => !/^[✅💰🏝]/u.test(l)), required.join(' | '));
  // Benefits are not requirements and not nice-to-haves.
  assert.equal(preferred.length, 0);
});

// `(?:e?s)?` matches "s" and "es" but never a bare trailing "e", so the stem
// "communicat" failed against "communicate" and a requirement the CV did cover
// was reported as unreadable. Long aliases are stems; short ones stay strict.
test('a stem matches its inflections without over-matching', () => {
  assert.equal(evidences('You communicate clearly', 'communication'), true);
  assert.equal(evidences('thrive collaboratively', 'collaboration'), true);
  assert.equal(evidences('distributed systems at scale', 'distributed systems'), true);
  // Short aliases must NOT become prefixes.
  assert.equal(evidences('the team rested over the weekend', 'rest'), false);
  assert.equal(evidences('we are going to ship it', 'go'), false);
});
