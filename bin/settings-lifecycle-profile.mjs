import { profileLifecycle } from './lifecycle-profile.mjs';

const [baseline, candidate, output, ...extra] = process.argv.slice(2);
if (!baseline || !candidate || !output || extra.length)
  throw new Error('Usage: node bin/settings-lifecycle-profile.mjs BASELINE_CHROME CANDIDATE_CHROME NEW_REPORT_JSON');
await profileLifecycle(baseline, candidate, output, { workload: 'settings' });
