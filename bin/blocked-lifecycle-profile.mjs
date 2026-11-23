import { profileLifecycle } from './lifecycle-profile.mjs';
import { renderLifecycleProfile } from './lifecycle-profile-report.mjs';

const [baseline, candidate, output, ...extra] = process.argv.slice(2);
if (!baseline || !candidate || !output || extra.length)
  throw new Error('Usage: node bin/blocked-lifecycle-profile.mjs BASELINE_CHROME CANDIDATE_CHROME NEW_REPORT_JSON');
console.log(renderLifecycleProfile(await profileLifecycle(baseline, candidate, output, { workload: 'blocked' })));
