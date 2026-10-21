// Turns a failed discovery run into a message that names its cause. Plain .mjs
// (same pattern as explore-error.mjs) so tests/lib/scanner-failure.test.mjs can
// import it without a TS runner, and so every caller describes a failure from
// ONE definition.
//
// The defect this exists for: runDiscovery() spawns the core scanner and, in
// --json mode, parses stdout as a single object at close. When that parse failed
// it reported "The scanner returned no readable output." — which is true, and
// useless. It restates the symptom the caller can already see and discards the
// reason, which the child process had already printed on stderr.
//
// Three structurally different things reach that branch, and only the last one
// is what the original message was written for:
//
//   1. The scanner CRASHED before printing anything. A missing core dependency
//      is the common first-run case: `npm ci` inside web/ installs the web app's
//      dependencies, NOT the core's, so every scanner import of js-yaml throws
//      ERR_MODULE_NOT_FOUND, stdout is empty, and the exit code is non-zero. The
//      user sees "no readable output" and has no way to reach `npm install`,
//      which is the entire fix.
//
//   2. The scanner was KILLED before it finished. runDiscovery arms a SIGTERM at
//      230s, so a close with a null exit code is that timeout rather than a
//      failure of the scan itself. The useful advice is to narrow the search,
//      not to retry the same one.
//
//   3. The scanner EXITED CLEANLY but stdout was not the JSON object the --json
//      contract promises. This is the defensive case ("shouldn't happen once the
//      probe passed") and it keeps the original copy.
//
// Classification is by EXIT CODE plus the stderr tail, never by the shape of
// stdout: an empty stdout is common to all three and cannot separate them.

/**
 * How much raw stderr to retain for diagnosis. A stack trace is a few hundred
 * bytes; this is generous enough for several while staying far below anything
 * that would burden the stream.
 */
export const STDERR_TAIL_MAX = 4000;

/** The original copy, kept for case 3 and shared with its test. */
export const NO_READABLE_OUTPUT = "The scanner returned no readable output.";

/** How many trailing stderr lines to quote back for an unrecognised crash. */
const QUOTED_LINES = 3;

/**
 * Describe why a discovery run produced no parseable stdout.
 *
 * @param {number|null} code   Exit code from child.on("close"). null means the
 *                             child was terminated by a signal — here, the
 *                             230s SIGTERM that runDiscovery arms.
 * @param {string} [stderrTail] Bounded raw tail of the child's stderr.
 * @returns {string} A message naming the cause, safe to show a user.
 */
export function describeScannerFailure(code, stderrTail = "") {
  const tail = String(stderrTail || "").trim();

  // A missing core dependency has one specific fix, and it is the failure a
  // first run is most likely to hit. Name the package and the command, because
  // "npm install in the root" is not guessable from the web/ setup docs.
  const missing = tail.match(/Cannot find package '([^']+)'/);
  if (missing || /ERR_MODULE_NOT_FOUND/.test(tail)) {
    const what = missing ? `\`${missing[1]}\` is not installed` : "a dependency is missing";
    return (
      `The scanner could not start: ${what}. Run \`npm install\` in the ` +
      `career-ops root — installing web/ does not install the core's dependencies.`
    );
  }

  // Killed by a signal. Retrying the identical search hits the same wall, so the
  // advice has to be to make the search smaller.
  if (code === null || code === undefined) {
    return (
      "The scanner was stopped before it finished, most likely the discovery " +
      "timeout. Narrow the search — fewer ATS sources, or a shorter posted-within " +
      "window — and run it again."
    );
  }

  // Any other non-zero exit is a crash whose reason is already on stderr.
  // Quoting the last few lines is the whole point of this function.
  if (code !== 0) {
    const lines = tail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const why = lines.slice(-QUOTED_LINES).join(" · ");
    return why
      ? `The scanner exited with code ${code}: ${why}`
      : `The scanner exited with code ${code} without printing a reason.`;
  }

  // Exit 0, stdout unparseable: the defensive case, unchanged.
  return NO_READABLE_OUTPUT;
}
