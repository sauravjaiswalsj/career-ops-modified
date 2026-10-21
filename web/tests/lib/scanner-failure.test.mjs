// Tests for describeScannerFailure() using Node's built-in test runner.
// Imports directly from scanner-failure.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/scanner-failure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeScannerFailure,
  NO_READABLE_OUTPUT,
  STDERR_TAIL_MAX,
} from "../../src/lib/scanner-failure.mjs";

// The first-run failure this change exists for. `npm ci` in web/ does not
// install the core's node_modules, so the scanner dies importing js-yaml before
// it writes a byte of stdout. The old message sent the user looking at the web
// app; the fix is one command in a different directory, so the message has to
// say so.
const MODULE_CRASH = `
node:internal/modules/package_json_reader:314
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml' imported from /home/u/career-ops/scan-ats-full.mjs
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)
  code: 'ERR_MODULE_NOT_FOUND'
}
`;

test("a missing core dependency names the package and the fix", () => {
  const msg = describeScannerFailure(1, MODULE_CRASH);
  assert.match(msg, /js-yaml/);
  assert.match(msg, /npm install/);
  // The directory is the entire point: the user has already run npm ci in web/.
  assert.match(msg, /career-ops root/);
  assert.notEqual(msg, NO_READABLE_OUTPUT);
});

// ERR_MODULE_NOT_FOUND without a quotable package name still routes to the
// dependency advice rather than falling through to a bare exit code.
test("a module-not-found without a package name still advises npm install", () => {
  const msg = describeScannerFailure(1, "Error [ERR_MODULE_NOT_FOUND]: something went wrong");
  assert.match(msg, /npm install/);
});

// A null exit code means a signal, and runDiscovery arms exactly one: the 230s
// SIGTERM. Retrying the same search reruns the same timeout, so the advice must
// be to shrink it.
test("a killed scan advises narrowing rather than retrying", () => {
  const msg = describeScannerFailure(null, "⚙ greenhouse — 812 companies");
  assert.match(msg, /stopped before it finished/);
  assert.match(msg, /Narrow the search/);
});

// An unrecognised crash still beats silence: quote what the child actually said.
test("an unrecognised crash quotes the tail of stderr", () => {
  const msg = describeScannerFailure(1, "line one\nline two\nTypeError: portals.map is not a function");
  assert.match(msg, /code 1/);
  assert.match(msg, /TypeError: portals\.map is not a function/);
});

// A crash that printed nothing must not produce a dangling "code 1:" with an
// empty reason after it.
test("a silent crash reads as a complete sentence", () => {
  const msg = describeScannerFailure(2, "   \n  \n");
  assert.match(msg, /code 2/);
  assert.doesNotMatch(msg, /:\s*$/);
});

// Case 3, unchanged: the scanner ran to completion and stdout simply was not the
// JSON object the --json contract promises. This is the branch the original
// message was written for and it keeps that copy verbatim.
test("a clean exit with unparseable stdout keeps the original message", () => {
  assert.equal(describeScannerFailure(0, ""), NO_READABLE_OUTPUT);
  assert.equal(describeScannerFailure(0, "⚙ greenhouse — 812 companies"), NO_READABLE_OUTPUT);
});

// Defensive: the tail is untrusted child output of unbounded length upstream.
// The cap belongs to the producer, but the describer must not choke on either
// an empty value or a large one.
test("missing or oversized stderr is handled", () => {
  assert.equal(describeScannerFailure(0), NO_READABLE_OUTPUT);
  assert.equal(describeScannerFailure(0, undefined), NO_READABLE_OUTPUT);
  const huge = "x".repeat(STDERR_TAIL_MAX * 2);
  assert.match(describeScannerFailure(1, huge), /code 1/);
});
