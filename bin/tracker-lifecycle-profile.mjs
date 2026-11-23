import { profileLifecycle } from './lifecycle-profile.mjs';

const [baseline, candidate, output, ...extra] = process.argv.slice(2);
const baselineIdle = extra.length === 1 && extra[0] === '--baseline-idle';
if (!baseline || !candidate || !output || (extra.length && !baselineIdle))
  throw new Error(
    'Usage: node bin/tracker-lifecycle-profile.mjs BASELINE_CHROME CANDIDATE_CHROME NEW_REPORT_JSON [--baseline-idle]'
  );
await profileLifecycle(baseline, candidate, output, { workload: 'trackers', baselineIdle });
