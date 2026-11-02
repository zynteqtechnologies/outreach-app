// Keep-Alive Script
// Pings your Outreach server endpoint so it never spins down or sleeps
const target = process.env.APP_URL || 'https://outreach.zynteqtechnologies.com';
const pingUrl = target.replace(/\/+$/, '') + '/api/ping';

console.log(`[keep-alive] Pinging: ${pingUrl}`);

fetch(pingUrl)
  .then((res) => res.json())
  .then((data) => {
    console.log('[keep-alive] Server responded successfully:', data);
  })
  .catch((err) => {
    console.error('[keep-alive] Ping failed (server may still be waking up):', err.message);
  });
