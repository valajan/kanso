import { metricLabels } from '../modules/performance/metrics.js';
import { hasStatus, metricsWithStatus } from '../modules/performance/status.js';

// Maps the per-metric status map to a GitHub commit status payload.
// A warning never blocks a merge — only a failed metric reports 'failure'.
export function commitStatusPayload(statuses) {
  const failed = metricsWithStatus(statuses, 'fail');
  if (failed.length > 0) {
    return {
      state: 'failure',
      description: `Performance regression detected on ${metricLabels(failed)}`,
    };
  }
  if (hasStatus(statuses, 'warn')) {
    return { state: 'success', description: 'Minor regressions — review before merging' };
  }
  return { state: 'success', description: 'All metrics within acceptable thresholds' };
}
