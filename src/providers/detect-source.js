// Derives a human-readable preview source label from a deployment context
// string and its target URL. Shared by the providers whose event payloads do
// not name the hosting platform explicitly (status, deployment_status).
export function detectSource(context, targetUrl) {
  const ctx = (context ?? '').toLowerCase();
  if (ctx.includes('cloudflare')) return 'Cloudflare Pages';
  if (ctx.includes('vercel')) return 'Vercel Preview';
  if (ctx.includes('netlify')) return 'Netlify Preview';
  if ((targetUrl ?? '').includes('.onrender.com')) return 'Render Preview';
  return 'Preview';
}
