async function initializeAnalytics() {
  if (!['createratio.com', 'www.createratio.com'].includes(location.hostname)) return;
  try {
    const { init } = await import('@plausible-analytics/tracker');
    init({ domain: 'createratio.com' });
  } catch {}
}

initializeAnalytics();
