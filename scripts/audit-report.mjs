import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

if (result.error) {
  console.error('Unable to run npm audit:', { errorType: result.error.name || 'Error' });
  process.exitCode = 2;
} else {
  let report;

  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('npm audit did not return valid JSON.');
    console.error('npm audit failed to produce JSON:', { exitStatus: result.status ?? -1 });
    process.exitCode = 2;
  }

  if (report) {
    if (report.error || !report.metadata?.vulnerabilities) {
      console.error('npm audit failed:', {
        errorCode: /^[A-Z0-9_]{1,64}$/.test(report.error?.code ?? '')
          ? report.error.code
          : 'invalid_response',
      });
      process.exitCode = 2;
    } else {
      const counts = report.metadata.vulnerabilities;
      const entries = Object.entries(report.vulnerabilities || {})
        .sort(([left], [right]) => left.localeCompare(right));

      console.log('npm audit total: ' + counts.total +
        ' (critical ' + counts.critical +
        ', high ' + counts.high +
        ', moderate ' + counts.moderate +
        ', low ' + counts.low + ')');

      for (const [name, vulnerability] of entries) {
        const fix = vulnerability.fixAvailable;
        const remedy = fix === false
          ? 'No fix'
          : typeof fix === 'object'
            ? 'Requires ' + fix.name + '@' + fix.version + (fix.isSemVerMajor ? ' (major)' : '')
            : 'Fix available';

        console.log(
          vulnerability.severity.padEnd(8) + ' ' +
          name.padEnd(36) + ' ' +
          (vulnerability.isDirect ? 'direct' : 'transitive').padEnd(10) + ' ' +
          remedy,
        );
      }

      if (process.argv.includes('--enforce') && (counts.high > 0 || counts.critical > 0)) {
        console.error('High/critical vulnerabilities remain. Resolve or explicitly review them.');
        process.exitCode = 1;
      }
    }
  }
}
