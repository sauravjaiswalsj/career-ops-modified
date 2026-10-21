#!/usr/bin/env node
/**
 * cv-pick.mjs — which CV you already have should go to this posting.
 *
 * jd-similarity.mjs answers that for ONE candidate: give it a new JD and one
 * previous JD or CV and it returns reuse / reuse-with-edits / regenerate. But
 * the question is never about one candidate. By the time it matters you have a
 * folder of generated CVs and a folder of saved JDs, and the real question is
 * "which of these, if any" — which meant running the pairwise tool once per
 * file and comparing the numbers by hand.
 *
 * This ranks them all in one pass, using jd-similarity's scoring unchanged, and
 * names the PDF to send.
 *
 * It is a RECOMMENDATION layer, like the tool it builds on: it reads, ranks and
 * reports. It never writes, never deletes a CV, and never generates one. Zero
 * LLM tokens — pure text comparison — which is the point, because regenerating
 * a CV costs tokens and reusing one does not.
 *
 * Candidates, in priority order:
 *   1. data/pdf-index.tsv — every CV this project has generated. Each row
 *      carries an `html` path, so the CV's text is readable without a PDF
 *      dependency (the core ships none).
 *   2. --dir <path> — any .md/.txt/.html in a directory. Defaults to jds/, so a
 *      fresh install with saved JDs but no generated CVs still gets an answer.
 *   3. cv.md — the master. Always included, so there is always one candidate
 *      and the output can never be an empty list.
 *
 * Usage:
 *   node cv-pick.mjs new-jd.txt
 *   node cv-pick.mjs new-jd.txt --dir jds --top 5
 *   node cv-pick.mjs new-jd.txt --json
 *   node cv-pick.mjs new-jd.txt --high 0.8 --medium 0.5
 *
 * Exit code: 0 when a reusable CV was found (reuse or reuse-with-edits), 1 when
 * the recommendation is to regenerate — so a script can branch on it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, isAbsolute, basename, extname } from 'path';
import { recommendCvReuse } from './jd-similarity.mjs';
import { coverage, analyze, evidenceSnippet } from './cv-coverage.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.html', '.htm', '.pdf', '.tex']);

/**
 * PDFs are read through poppler's pdftotext when it is on PATH. Most people's
 * CVs are PDFs, so refusing them would make this tool useless for exactly the
 * files it exists to rank — but adding a PDF parser as an npm dependency for
 * one feature is not a trade the core should make. When pdftotext is absent the
 * file is skipped with a reason, never silently dropped.
 */
function pdfToText(path) {
  const r = spawnSync('pdftotext', ['-layout', path, '-'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(
      r.error?.code === 'ENOENT'
        ? 'pdftotext not installed (brew install poppler / apt install poppler-utils)'
        : `pdftotext failed on ${basename(path)}`,
    );
  }
  return r.stdout ?? '';
}

/** Decisions ordered best-first, so ranking never puts a worse call on top. */
const DECISION_RANK = { reuse: 3, 'reuse-with-edits': 2, regenerate: 1 };

/**
 * Reduce an HTML CV to the text an ATS or a reader would see. Deliberately not
 * a parser: script/style bodies are dropped, tags are unwrapped, entities that
 * actually appear in these documents are decoded. Anything more would be a
 * dependency, and the comparison downstream is bag-of-words anyway.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:#39|#x27|rsquo|apos);/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce a LaTeX CV to its prose. Many people keep the .tex as the source of
 * truth and the PDF as an artefact, so reading the source directly avoids a
 * render step and is more faithful than text extracted from a PDF — no line
 * wrapping, no ligature loss, no column guessing.
 *
 * Deliberately not a LaTeX parser: strip the preamble, drop comments, unwrap
 * the text-carrying commands, discard the rest. Good enough for a bag of
 * capabilities, which is all the score needs.
 */
export function texToText(tex) {
  let t = String(tex ?? '');
  const begin = t.indexOf('\\begin{document}');
  if (begin >= 0) t = t.slice(begin + '\\begin{document}'.length);
  return t
    .replace(/(^|[^\\])%.*$/gm, '$1')                     // comments, not \%
    .replace(/\\(?:textbf|textit|texttt|underline|emph|href|section|resumeItem)\*?\{/g, '{')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, ' ')          // remaining commands
    .replace(/[{}$&~^]/g, ' ')
    .replace(/\\\\/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Read a document as plain text, converting HTML when that is what it is. */
export function readAsText(path) {
  if (/\.pdf$/i.test(path)) return pdfToText(path);
  const raw = readFileSync(path, 'utf8');
  if (/\.html?$/i.test(path)) return htmlToText(raw);
  if (/\.tex$/i.test(path)) return texToText(raw);
  return raw;
}

/**
 * Parse data/pdf-index.tsv into candidate descriptors.
 *
 * Columns are `report, pdf, html, format, date` with paths relative to the
 * project root. Rows are read by POSITION and short rows are tolerated: the
 * manifest gained columns over time and older installs still carry the shorter
 * shape, exactly as data/scan-history.tsv does.
 *
 * @param {string} root Project root.
 * @returns {{label: string, textPath: string, pdf: string|null, date: string|null}[]}
 */
export function candidatesFromPdfIndex(root) {
  const manifest = join(root, 'data/pdf-index.tsv');
  if (!existsSync(manifest)) return [];
  const out = [];
  for (const line of readFileSync(manifest, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [report, pdf, html, , date] = line.split('\t');
    // The html column is what makes the CV's own text readable. A row without
    // one is not a defect — it predates the column — so fall back to the
    // report, which at least carries the role's language.
    const textRel = (html && html.trim()) || (report && report.trim());
    if (!textRel) continue;
    const textPath = join(root, textRel);
    if (!existsSync(textPath)) continue;
    out.push({
      label: basename(pdf?.trim() || textRel),
      textPath,
      pdf: pdf?.trim() || null,
      date: date?.trim() || null,
    });
  }
  return out;
}

/**
 * Does this document look like a CV at all?
 *
 * A folder of CVs usually also holds saved job descriptions, notes and company
 * lists. Ranking those produces confident nonsense — a JD scored against a JD
 * looks like a strong CV — so a candidate must show at least two of the marks
 * every real CV carries. Deliberately loose: a false negative silently drops a
 * real CV, so the bar is "recognisably a CV", not "well-formatted".
 */
export function looksLikeCv(text) {
  const t = String(text ?? '');
  const marks = [
    /[\w.\-+]+@[\w-]+\.[\w.\-]+/.test(t),                       // contact address
    /\b(experience|employment|work history)\b/i.test(t),         // history section
    /\b(education|university|bachelor|msc|b\.?tech)\b/i.test(t),  // education section
    /\b(skills?|technologies)\b/i.test(t),                       // skills section
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}\s*(?:-|–|—|to)\s*/i.test(t),
  ].filter(Boolean).length;
  return marks >= 3;
}

/** Every readable text document directly inside `dir` (not recursive). */
export function candidatesFromDir(root, dir) {
  // join(root, '/tmp/cvs') is root/tmp/cvs, not /tmp/cvs, so an absolute --dir
  // silently resolved to a path that does not exist and reported no candidates.
  const abs = isAbsolute(dir) ? dir : join(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  return readdirSync(abs)
    .filter(f => !f.startsWith('.') && TEXT_EXTENSIONS.has(extname(f).toLowerCase()))
    .map(f => {
      const textPath = join(abs, f);
      // The file's own date, so ties break toward the CV you last maintained
      // and a stale variant is visible rather than silently winning.
      const date = statSync(textPath).mtime.toISOString().slice(0, 10);
      return { label: f, textPath, pdf: null, date };
    })
    .filter(c => statSync(c.textPath).isFile());
}

/**
 * Rank candidates against a new JD, best first.
 *
 * Ordering is by DECISION first and score second. Sorting on score alone would
 * float a high-scoring `regenerate` above a lower-scoring `reuse`, and the
 * decision is the thing being asked for — a level mismatch makes a CV wrong to
 * send however much vocabulary it shares.
 *
 * @param {string} newJd Text of the posting.
 * @param {{label: string, textPath: string}[]} candidates
 * @param {{highThreshold?: number, mediumThreshold?: number}} [options]
 */
export function rankCandidates(newJd, candidates, options = {}, skipped = []) {
  const scored = [];
  for (const candidate of candidates) {
    let text;
    try {
      text = readAsText(candidate.textPath);
    } catch (e) {
      // Never fatal, but never silent either: a CV missing from the ranking
      // with no explanation looks like the tool ignored it.
      skipped.push({ label: candidate.label, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!text.trim()) continue;
    if (!looksLikeCv(text)) {
      skipped.push({ label: candidate.label, reason: 'does not look like a CV' });
      continue;
    }
    // Coverage is the ranking signal. jd-similarity's whole-document Jaccard is
    // kept as a secondary reading because it answers a different question well
    // ("is this the same posting again"), but it cannot separate CVs: measured
    // on real files every candidate lands within a few points of every other,
    // all far below its own 0.45 threshold. See cv-coverage.mjs for the numbers.
    const cov = analyze(newJd, text);
    const reuse = recommendCvReuse(newJd, text, options);
    scored.push({
      ...candidate,
      ...reuse,
      similarity: reuse.score,
      score: cov.ratio,
      items: cov.items,
      covered: cov.items.filter(i => i.covered).map(i => i.coveredBy),
      missing: cov.items.filter(i => !i.covered).map(i => i.key),
      requirements: cov.total,
      unmatched: cov.unmatched,
      preferredMet: cov.preferredMet,
      preferredMissing: cov.preferredMissing,
      contextGaps: cov.contextGaps,
      text,
      levelMismatch: reuse.reason === 'level-mismatch',
    });
  }
  scored.sort(
    (a, b) =>
      Number(a.levelMismatch) - Number(b.levelMismatch) ||
      b.score - a.score ||
      b.similarity - a.similarity ||
      a.label.localeCompare(b.label),
  );
  return scored;
}

/** Gather every candidate, de-duplicated by resolved text path. */
export function collectCandidates(root, dir) {
  const all = [...candidatesFromPdfIndex(root), ...candidatesFromDir(root, dir)];
  const masterCv = join(root, 'cv.md');
  if (existsSync(masterCv)) {
    all.push({ label: 'cv.md (master)', textPath: masterCv, pdf: null, date: null });
  }
  const seen = new Set();
  return all.filter(c => !seen.has(c.textPath) && seen.add(c.textPath));
}

/** The overall call: what to do about this posting. */
export function pick(newJd, candidates, options = {}) {
  const skipped = [];
  const ranked = rankCandidates(newJd, candidates, options, skipped);
  // For each CV's gaps, look for a sentence in a DIFFERENT CV that covers it.
  // A capability missing everywhere is a real gap; one present in another file
  // is a copy-paste away, and telling the two apart is the whole job.
  for (const r of ranked) {
    r.crossReferences = [];
    for (const item of r.items.filter(i => !i.covered)) {
      for (const other of ranked) {
        if (other.label === r.label) continue;
        const hit = item.capabilities.find(c => other.items.some(i => i.coveredBy === c));
        if (!hit) continue;
        const snippet = evidenceSnippet(other.text, hit);
        if (snippet) {
          r.crossReferences.push({ capability: item.key, source: other.label, snippet });
          break;
        }
      }
    }
    delete r.text; // never ship whole CV bodies to the client
  }

  const best = ranked[0] ?? null;
  // Thresholds are on requirement coverage, which is a proportion of things the
  // posting actually asked for, so they mean something a reader can check.
  let decision = 'regenerate';
  if (best && !best.levelMismatch && best.requirements > 0) {
    if (best.score >= 0.85) decision = 'reuse';
    else if (best.score >= 0.6) decision = 'reuse-with-edits';
  }
  let reason = 'no candidates';
  if (best) {
    if (best.requirements === 0) reason = 'no-parseable-requirements';
    else if (best.levelMismatch) reason = 'level-mismatch';
    else if (decision === 'regenerate') reason = 'low-coverage';
    else reason = 'coverage';
  }
  return { decision, reason, best, ranked, skipped };
}

// ── CLI ─────────────────────────────────────────────────────────────

const VALUE_FLAGS = ['--dir', '--top', '--high', '--medium'];
const BOOL_FLAGS = ['--json', '--help', '-h'];

const USAGE = `Usage:
  node cv-pick.mjs new-jd.txt [--dir jds] [--top N] [--json]
  node cv-pick.mjs new-jd.txt [--high 0.72] [--medium 0.45]
  node cv-pick.mjs --help`;

function valueOf(args, flag) {
  const inline = args.find(a => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function numberOr(raw, fallback, flag) {
  if (raw === undefined) return fallback;
  // Whole-string match, not parseFloat: parseFloat('0.7x') is 0.7, which
  // silently accepts a typo as a threshold.
  if (!/^\d*\.?\d+$/.test(String(raw))) {
    console.error(`Error: ${flag} expects a number, got "${raw}".`);
    process.exit(1);
  }
  return Number(raw);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = args.filter(
    (a, i) =>
      a.startsWith('-') &&
      !BOOL_FLAGS.includes(a) &&
      !VALUE_FLAGS.some(f => a === f || a.startsWith(`${f}=`)) &&
      !(i > 0 && VALUE_FLAGS.includes(args[i - 1])),
  );
  if (unknown.length) {
    console.error(`Error: unrecognized flag(s): ${unknown.join(', ')}`);
    console.error(USAGE);
    return 1;
  }
  const positional = args.filter(
    (a, i) => !a.startsWith('-') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])),
  );
  if (positional.length !== 1) {
    console.error('Error: expected exactly one job-description file.');
    console.error(USAGE);
    return 1;
  }

  const root = getCareerOpsRoot();
  const dir = valueOf(args, '--dir') ?? 'jds';
  const top = numberOr(valueOf(args, '--top'), 10, '--top');
  const options = {
    highThreshold: numberOr(valueOf(args, '--high'), undefined, '--high'),
    mediumThreshold: numberOr(valueOf(args, '--medium'), undefined, '--medium'),
  };

  let newJd;
  try {
    newJd = readAsText(positional[0]);
  } catch (error) {
    console.error(`Unable to read ${positional[0]}: ${error.message}`);
    return 1;
  }

  const candidates = collectCandidates(root, dir);
  const { decision, reason, best, ranked, skipped } = pick(newJd, candidates, options);

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          decision,
          reason,
          skipped,
          best: best && { label: best.label, pdf: best.pdf, coverage: best.score },
          ranked: ranked.slice(0, top).map(r => ({
            label: r.label,
            pdf: r.pdf,
            date: r.date,
            coverage: Number(r.score.toFixed(4)),
            similarity: Number(r.similarity.toFixed(4)),
            requirements: r.requirements,
            covered: r.covered,
            missing: r.missing,
            items: r.items,
            unmatched: r.unmatched,
            preferredMet: r.preferredMet,
            preferredMissing: r.preferredMissing,
            crossReferences: r.crossReferences,
            contextGaps: r.contextGaps,
            levelMismatch: r.levelMismatch,
          })),
        },
        null,
        2,
      ),
    );
    return decision === 'regenerate' ? 1 : 0;
  }

  if (!ranked.length) {
    console.log('No CVs or saved JDs to compare against yet.');
    console.log(`Looked in data/pdf-index.tsv, ${dir}/ and cv.md.`);
    console.log('Recommendation: regenerate (there is nothing to reuse).');
    return 1;
  }

  console.log(`\nCV fit for ${basename(positional[0])}`);
  console.log(`${ranked[0].requirements} requirement areas parsed from the posting.`);
  console.log('-'.repeat(62));
  for (const r of ranked.slice(0, top)) {
    const flag = r.levelMismatch ? '  [different seniority]' : '';
    console.log(`  ${(r.score * 100).toFixed(0).padStart(3)}%  ${r.label}${flag}`);
    if (r.missing.length) console.log(`        missing: ${r.missing.join(', ')}`);
  }

  if (skipped.length) {
    console.log('');
    for (const sk of skipped) console.log(`  skipped ${sk.label} — ${sk.reason}`);
  }

  console.log('');
  if (decision === 'regenerate') {
    const why = best?.levelMismatch
      ? 'the closest match is written at a different seniority level'
      : `the best candidate evidences only ${Math.round((best?.score ?? 0) * 100)}% of the stated requirements`;
    console.log(`REGENERATE — ${why}.`);
  } else {
    console.log(`${decision.toUpperCase()} — ${best.pdf ?? best.label}`);
    if (best.missing.length) {
      console.log(`  Still missing: ${best.missing.join(', ')}`);
      console.log('  Only add these if you have actually done them.');
    }
  }
  console.log(
    '\n  Ranked on requirement coverage (cv-coverage.mjs), not keyword overlap.\n' +
    '  A capability the posting only mentions as part of THEIR stack is context,\n' +
    '  not a requirement, and does not count against you.\n',
  );
  return decision === 'regenerate' ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
