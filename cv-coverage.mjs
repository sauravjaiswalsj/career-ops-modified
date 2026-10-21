#!/usr/bin/env node
/**
 * cv-coverage.mjs — how much of a posting's stated requirements a CV evidences.
 *
 * Why this exists alongside jd-similarity.mjs. That module scores whole-document
 * Jaccard overlap, which is the right measure for "is this the same posting
 * again" and the wrong one for "does this CV fit this posting". Measured on real
 * files: a JD against itself scores 1.00, but two genuinely similar backend JDs
 * score 0.057 and a JD against a matching CV scores 0.070 — both far under the
 * 0.45 reuse-with-edits threshold. A job description is mostly boilerplate
 * (benefits, EEO text, company blurb) and that boilerplate drowns the signal, so
 * every real comparison collapses to "regenerate".
 *
 * This measures something narrower and more useful: pull the REQUIREMENT lines
 * out of the posting, reduce each to the capabilities it names, and ask whether
 * the CV evidences each one. Boilerplate contributes nothing because it is never
 * a requirement line.
 *
 * Two rules carry most of the accuracy:
 *
 *   1. A section describing the employer's stack ("what you'll be working on",
 *      "our tech stack") is CONTEXT, not an entry requirement. Counting it as
 *      required marks a candidate down for not already knowing tools the
 *      employer offers to teach.
 *
 *   2. A line naming alternatives ("Go, Java, C or Scala") is ONE requirement
 *      satisfied by any of them, not four separate misses.
 *
 * Read-only, deterministic, zero LLM tokens.
 */

/** Capability -> the strings that evidence it. Aliases matter: a posting saying
 * "GCP" and a CV saying "Google Cloud" is a match, and a matcher that misses
 * that reports a gap that is not real. */
export const CAPABILITIES = {
  java: ['java', 'jvm', 'kotlin'],
  spring: ['spring', 'spring boot', 'springboot'],
  kafka: ['kafka', 'kstreams', 'kafka streams'],
  'event-driven': ['event-driven', 'event driven', 'pub/sub', 'pubsub', 'message queue', 'messaging', 'event sourcing', 'event backbone'],
  'distributed systems': ['distributed system', 'distributed comput', 'consensus', 'raft', 'replication', 'partition'],
  microservices: ['microservice', 'micro-service', 'service-oriented'],
  grpc: ['grpc', 'protobuf', 'protocol buffer'],
  rest: ['rest', 'restful', 'rest api', 'http api'],
  graphql: ['graphql'],
  python: ['python'],
  go: ['golang', 'go lang'],
  scala: ['scala'],
  rust: ['rust'],
  'c#': ['c#', '.net', 'dotnet'],
  'c++': ['c++', 'cpp'],
  typescript: ['typescript'],
  javascript: ['javascript', 'node.js', 'nodejs', 'express'],
  react: ['react', 'next.js', 'nextjs'],
  sql: ['sql', 'postgres', 'postgresql', 'mysql', 'oracle', 'rdbms'],
  nosql: ['nosql', 'mongodb', 'cassandra', 'dynamodb', 'redis'],
  aws: ['aws', 'amazon web services', 'ec2', 's3', 'lambda'],
  gcp: ['gcp', 'google cloud', 'bigquery'],
  azure: ['azure'],
  kubernetes: ['kubernetes', 'k8s', 'eks', 'gke', 'aks'],
  docker: ['docker', 'container'],
  terraform: ['terraform', 'infrastructure as code', 'pulumi'],
  'ci/cd': ['ci/cd', 'cicd', 'continuous integration', 'continuous deliver', 'jenkins', 'github actions'],
  observability: ['observabilit', 'prometheus', 'grafana', 'datadog', 'opentelemetry', 'monitoring'],
  testing: ['unit test', 'integration test', 'junit', 'pytest', 'tdd', 'test automation'],
  linux: ['linux', 'unix'],
  llm: ['llm', 'large language model', 'genai', 'gen ai', 'generative ai', 'rag', 'retrieval augmented', 'prompt engineering', 'langchain'],
  ml: ['machine learning', 'pytorch', 'tensorflow', 'scikit'],
  'data pipelines': ['spark', 'hadoop', 'flink', 'databricks', 'etl', 'data pipeline', 'airflow'],
  security: ['oauth', 'oidc', 'jwt', 'authentication', 'authorization', 'encryption', 'tls'],
  'finance domain': ['fintech', 'trading', 'payments', 'banking', 'insurance', 'wealth', 'capital markets', 'settlement', 'ledger'],
  'security engineering': ['vulnerabilit', 'penetration test', 'pentest', 'threat model', 'threat detection', 'malware', 'siem', 'security operations', 'hardening', 'patch management', 'patch verification', 'cve', 'intrusion', 'forensics', 'incident response'],
  compliance: ['complian', 'gdpr', 'soc 2', 'soc2', 'iso 27001', 'pci', 'audit', 'regulatory', 'governance'],
  networking: ['tcp/ip', 'dns', 'http/2', 'load balanc', 'reverse proxy', 'firewall', 'vpn', 'cross-domain', 'network protocol', 'network security', 'networking', 'air-gapped', 'subnet', 'bgp'],
  'customer facing': ['customer-facing', 'client-facing', 'stakeholder', 'pre-sales', 'presales', 'solutions engineer', 'solution engineer', 'forward deployed', 'field deployment', 'customer engineering', 'customer discovery', 'customer onboarding', 'embedded with'],
  'technical leadership': ['subject matter expert', 'tech lead', 'technical ownership', 'drive adoption', 'influence', 'roadmap'],
  scripting: ['bash', 'shell', 'powershell', 'automation script'],
  'api integration': ['api integration', 'webhook', 'sdk', 'third-party api', 'system integration'],
  'api design': ['api design', 'designing api', 'design beautiful api', 'openapi', 'rest api design', 'developer experience', 'api contract', 'restful json api'],
  'code quality': ['code quality', 'code review', 'clean code', 'refactor', 'test coverage', 'tdd', 'unit test', 'automated testing', 'junit'],
  'engineering standards': ['engineering standard', 'best practice', 'coding standard', 'engineering process', 'technical standard', 'sdlc'],
  communication: ['communicat', 'articulat', 'presented', 'documented', 'wrote the design', 'stakeholder', 'workshop', 'training session'],
  collaboration: ['collaborat', 'cross-functional', 'agile squad', 'pair programming', 'worked with the team', 'feedback'],
  'product thinking': ['business impact', 'product mindset', 'tradeoff', 'trade-off', 'customer outcome', 'commercial', 'roi', 'prioritis', 'prioritiz'],
  mentoring: ['mentor', 'mentored', 'mentoring', 'coached', 'taught', 'training'],
  'design ownership': ['design document', 'design doc', 'system design', 'architected', 'authored the design'],
  'production ownership': ['on-call', 'on call', 'incident', 'production support', 'sre', 'escalation'],
};

const REQUIRED_HEADING = /(requirement|qualification|what (you|we)('|’)?ll? need|about you|who you are|we('|’)?re looking for|you (have|bring)|must have|minimum|your profile|what you bring|you should apply if|ideal candidate|your background|skills? (and|&) experience|you('|’)?ll thrive|thrive here if|you('|’)?d be a (great|good) fit|what makes a great|we('|’)?d love to (meet|hear)|you might be a fit)/i;
const PREFERRED_HEADING = /(nice[- ]to[- ]have|bonus|preferred|desirable|would be great|advantage|good to have|plus(es)?\b)/i;
const CONTEXT_HEADING = /(what you('|’)?ll (be )?(work|do|build)|responsibilities|the role|about the role|day[- ]to[- ]day|in this role|our (tech )?stack|tech(nologies)? we use|about (the )?team|you will\b)/i;
const STOP_HEADING = /(benefits?|perks?|what we offer|what you('|’)?ll get|what('|’)?s in it for you|the package|why join|why now|our offer|compensation|salary|equal opportunit|diversity|about (us|the company)|our (values|mission)|how to apply|interview process|privacy)/i;
const ALTERNATION = /(\bor\b|\betc\b|\bsuch as\b|\be\.g\.|\bone of\b|\bany of\b|\bsimilar\b|\bideally\b)/i;
const BULLET_START =
  /^\s*(?:[-*•●▪‣⁃–—>]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2705}\u{274C}]+)\s*/u;
/** Strip a leading bullet marker of any kind, emoji included. */
function stripBullet(line) {
  return line.replace(BULLET_START, '').trim();
}

/**
 * Split a posting into required / preferred / context bullet lines.
 *
 * Context is tested BEFORE required on purpose: "what you'll be working on"
 * also matches the required pattern, and treating an employer's description of
 * their own stack as an entry requirement is the single biggest source of false
 * gaps.
 *
 * @param {string} jd
 */
export function extractRequirements(jd) {
  const required = [];
  const preferred = [];
  const context = [];
  let mode = null;
  for (const raw of String(jd ?? '').split(/\r?\n/)) {
    const line = stripBullet(raw.trim());
    if (!line) continue;
    const isBullet = BULLET_START.test(raw);
    if (line.length < 90 && !isBullet) {
      if (STOP_HEADING.test(line)) { mode = 'stop'; continue; }
      if (PREFERRED_HEADING.test(line)) { mode = 'preferred'; continue; }
      if (CONTEXT_HEADING.test(line)) { mode = 'context'; continue; }
      if (REQUIRED_HEADING.test(line)) { mode = 'required'; continue; }
    }
    if (mode === 'stop' || line.length < 16) continue;
    const looksLikeItem = isBullet || (mode === 'required' || mode === 'preferred') && line.length < 320;
    if (!looksLikeItem) continue;
    if (mode === 'preferred') preferred.push(line);
    else if (mode === 'context') context.push(line);
    else if (mode === 'required') required.push(line);
  }
  // No recognisable requirement heading: fall back to bullets we have not
  // already filed as context, so a prose-shaped posting still yields something.
  if (!required.length && !preferred.length) {
    const seen = new Set(context.map(normalize));
    for (const raw of String(jd ?? '').split(/\r?\n/)) {
      if (!BULLET_START.test(raw)) continue;
      const line = stripBullet(raw.trim());
      if (line.length > 20 && !seen.has(normalize(line))) required.push(line);
    }
  }
  return { required: dedupe(required), preferred: dedupe(preferred), context: dedupe(context) };
}

function normalize(s) {
  return String(s).toLowerCase().replace(/\W+/g, '').slice(0, 80);
}

function dedupe(lines) {
  const seen = new Set();
  return lines.filter(l => {
    const k = normalize(l);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Whether `text` evidences `capability`, tolerating plurals. */
export function evidences(text, capability) {
  const aliases = CAPABILITIES[capability] ?? [capability];
  const haystack = String(text ?? '').toLowerCase();
  return aliases.some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word endings matter. `(?:e?s)?` matches "s" and "es" but NOT a bare
    // trailing "e", so the stem "communicat" failed against "communicate" and
    // the requirement was reported as unreadable. A long alias is treated as a
    // STEM and may be followed by any letters ("collaborat" -> "collaboratively",
    // "communicat" -> "communication"); a short one keeps the strict plural
    // rule, because "rest" must not match "rested" and "go" must not match
    // "going".
    const tail = alias.length >= 9 ? '[a-z]*' : '(?:e?s)?';
    return new RegExp(`(?<![a-z0-9])${escaped}${tail}(?![a-z0-9])`, 'i').test(haystack);
  });
}

/** Which capabilities a requirement line names. */
export function capabilitiesIn(line) {
  return Object.keys(CAPABILITIES).filter(c => evidences(line, c));
}

/**
 * Score a CV against a posting.
 *
 * @param {string} jd Posting text.
 * @param {string} cv CV text.
 * @returns {{ratio: number, covered: string[], missing: string[], total: number,
 *            contextGaps: string[]}}
 */
export function coverage(jd, cv) {
  const { required, context } = extractRequirements(jd);
  const groups = [];
  for (const line of required) {
    const caps = capabilitiesIn(line);
    if (!caps.length) continue;
    // An alternation line is one requirement with several acceptable answers.
    if (caps.length > 1 && ALTERNATION.test(line)) groups.push(caps);
    else for (const c of caps) groups.push([c]);
  }
  // Collapse duplicate single-capability groups so a capability named in three
  // bullets is not counted three times.
  const seen = new Set();
  const unique = groups.filter(g => {
    if (g.length > 1) return true;
    if (seen.has(g[0])) return false;
    seen.add(g[0]);
    return true;
  });

  const covered = [];
  const missing = [];
  for (const group of unique) {
    const hit = group.find(c => evidences(cv, c));
    if (hit) covered.push(hit);
    else missing.push(group.join('/'));
  }
  const total = unique.length;
  const contextCaps = [...new Set(context.flatMap(capabilitiesIn))];
  return {
    ratio: total ? covered.length / total : 0,
    covered: [...new Set(covered)].sort(),
    missing: [...new Set(missing)].sort(),
    total,
    contextGaps: contextCaps.filter(c => !evidences(cv, c)).sort(),
  };
}


/**
 * The posting broken into scoreable requirement groups, plus the lines the
 * vocabulary could not classify.
 *
 * `unmatched` is not padding. A requirement naming a capability CAPABILITIES
 * has never heard of is invisible to the score, and a tool that silently drops
 * it reports a confident number over a fraction of the posting. Surfacing the
 * count is the difference between "you cover 75%" and "you cover 75% of the
 * three quarters I could read".
 *
 * @param {string} jd
 */
export function analyzeRequirements(jd) {
  const { required, preferred, context } = extractRequirements(jd);
  const groups = [];
  const unmatched = [];
  const seen = new Set();
  for (const line of required) {
    const caps = capabilitiesIn(line);
    if (!caps.length) {
      unmatched.push(line);
      continue;
    }
    if (caps.length > 1 && ALTERNATION.test(line)) {
      groups.push({ key: caps.join('/'), capabilities: caps, line, alternatives: true });
      continue;
    }
    for (const c of caps) {
      if (seen.has(c)) continue;
      seen.add(c);
      groups.push({ key: c, capabilities: [c], line, alternatives: false });
    }
  }
  return {
    groups,
    unmatched,
    preferred: [...new Set(preferred.flatMap(capabilitiesIn))],
    contextCapabilities: [...new Set(context.flatMap(capabilitiesIn))],
    requiredLines: required.length,
  };
}

/**
 * The sentence in `text` that evidences `capability`, for showing the user the
 * proof rather than asserting it. Returns null when nothing matches.
 *
 * @param {string} text
 * @param {string} capability
 * @param {number} [width] Characters of context around the match.
 */
export function evidenceSnippet(text, capability, width = 150) {
  const aliases = CAPABILITIES[capability] ?? [capability];
  const haystack = String(text ?? '');
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?<![a-z0-9])${escaped}(?:e?s)?(?![a-z0-9])`, 'i').exec(haystack);
    if (!m) continue;
    const lo = Math.max(0, m.index - Math.floor(width / 3));
    const frag = haystack.slice(lo, m.index + width).replace(/\s+/g, ' ').trim();
    return (lo > 0 ? '…' : '') + frag + (m.index + width < haystack.length ? '…' : '');
  }
  return null;
}

/**
 * Full per-requirement result for one CV against one posting.
 *
 * @param {string} jd
 * @param {string} cv
 */
export function analyze(jd, cv) {
  const { groups, unmatched, preferred, contextCapabilities, requiredLines } = analyzeRequirements(jd);
  const items = groups.map(g => {
    const hit = g.capabilities.find(c => evidences(cv, c)) ?? null;
    return {
      key: g.key,
      capabilities: g.capabilities,
      alternatives: g.alternatives,
      askedFor: g.line,
      covered: Boolean(hit),
      coveredBy: hit,
      evidence: hit ? evidenceSnippet(cv, hit) : null,
    };
  });
  const covered = items.filter(i => i.covered);
  return {
    ratio: items.length ? covered.length / items.length : 0,
    total: items.length,
    items,
    unmatched,
    preferredMet: preferred.filter(c => evidences(cv, c)),
    preferredMissing: preferred.filter(c => !evidences(cv, c)),
    contextGaps: contextCapabilities.filter(c => !evidences(cv, c)),
    requiredLines,
  };
}
