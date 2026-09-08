import { spawnSync } from 'node:child_process';

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

// web-ext 10.6.0 -> addons-linter 10.10.0 -> image-size 2.0.2.
// No patched image-size release exists yet. These advisories can only cause a
// denial of service while linting crafted image files; CI only lints the
// repository's reviewed extension assets. Keep the exception exact so any new
// high/critical advisory still fails the build.
const allowedImageSizeAdvisories = new Set([
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
]);

const npmCli = process.env.npm_execpath;
const auditCommand = npmCli ? process.execPath : 'npm';
const auditArgs = npmCli
  ? [npmCli, 'audit', '--json', '--audit-level=high']
  : ['audit', '--json', '--audit-level=high'];
const audit = spawnSync(auditCommand, auditArgs, {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
});

if (audit.error) throw audit.error;

let report;
try {
  report = JSON.parse(audit.stdout || '{}');
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'npm audit returned invalid JSON\n');
  process.exit(1);
}

if (report.error || (audit.status !== 0 && audit.status !== 1)) {
  process.stderr.write(JSON.stringify(report.error || report, null, 2));
  process.exit(1);
}

const relevant = Object.entries(report.vulnerabilities || {}).filter(([, vulnerability]) =>
  severityRank[vulnerability.severity] >= severityRank.high
);

const isExactStringChain = (vulnerability, dependencyName) =>
  vulnerability.via.length === 1 && vulnerability.via[0] === dependencyName;

const isAllowed = ([name, vulnerability]) => {
  if (name === 'image-size') {
    const advisoryUrls = vulnerability.via
      .filter((item) => item && typeof item === 'object')
      .map((item) => item.url);
    return advisoryUrls.length === allowedImageSizeAdvisories.size &&
      advisoryUrls.every((url) => allowedImageSizeAdvisories.has(url));
  }
  if (name === 'addons-linter') return isExactStringChain(vulnerability, 'image-size');
  if (name === 'web-ext') return isExactStringChain(vulnerability, 'addons-linter');
  return false;
};

const unapproved = relevant.filter((entry) => !isAllowed(entry));
if (unapproved.length > 0) {
  console.error('npm audit found unapproved high/critical vulnerabilities:');
  for (const [name, vulnerability] of unapproved) {
    console.error(`- ${name}: ${vulnerability.severity}`);
  }
  process.exit(1);
}

if (relevant.length > 0) {
  console.warn('Acknowledged the two pinned image-size DoS advisories used only by web-ext linting.');
}
console.log('Dependency audit passed: no unapproved high/critical vulnerabilities.');
