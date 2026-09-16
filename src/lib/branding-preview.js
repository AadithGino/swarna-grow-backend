function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function brandContext(tenant) {
  const branding = tenant.branding ?? {};
  return {
    primary: branding.primaryColor ?? "#730321",
    accent: branding.accentColor ?? "#C9A227",
    appName:
      branding.displayName ?? tenant.displayName ?? tenant.name ?? "Your app",
    businessName: tenant.name ?? "Your business",
    code: tenant.code ?? "",
  };
}

export function buildBrandingPreviewUrls(tenant) {
  const b = brandContext(tenant);
  const initials = b.appName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const appIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${escapeXml(b.primary)}"/>
      <stop offset="100%" stop-color="${escapeXml(b.accent)}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <text x="256" y="280" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="120" font-weight="700">${escapeXml(initials || "SG")}</text>
  <text x="256" y="380" text-anchor="middle" fill="#ffffff" opacity="0.9" font-family="system-ui,sans-serif" font-size="28" font-weight="600">${escapeXml(b.appName.slice(0, 18))}</text>
</svg>`;

  const receiptSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240" viewBox="0 0 800 240">
  <rect width="800" height="240" fill="#ffffff"/>
  <rect width="800" height="72" fill="${escapeXml(b.primary)}"/>
  <text x="32" y="46" fill="#ffffff" font-family="system-ui,sans-serif" font-size="26" font-weight="700">${escapeXml(b.businessName)}</text>
  <text x="768" y="46" text-anchor="end" fill="#ffffff" opacity="0.85" font-family="ui-monospace,monospace" font-size="18">${escapeXml(b.code)}</text>
  <rect x="32" y="96" width="736" height="4" fill="${escapeXml(b.accent)}"/>
  <text x="32" y="130" fill="#444" font-family="system-ui,sans-serif" font-size="16">Receipt preview · ${escapeXml(b.appName)}</text>
  <text x="32" y="158" fill="#666" font-family="system-ui,sans-serif" font-size="14">Instalment payment · Sample customer</text>
  <text x="32" y="200" fill="${escapeXml(b.primary)}" font-family="system-ui,sans-serif" font-size="22" font-weight="700">₹2,000</text>
  <text x="768" y="200" text-anchor="end" fill="#888" font-family="ui-monospace,monospace" font-size="13">RCP-2026-0000001</text>
</svg>`;

  const passbookSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
  <defs>
    <linearGradient id="pg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${escapeXml(b.primary)}"/>
      <stop offset="45%" stop-color="${escapeXml(b.accent)}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#faf6f4"/>
    </linearGradient>
  </defs>
  <rect width="600" height="900" rx="24" fill="url(#pg)"/>
  <rect x="40" y="520" width="520" height="320" rx="16" fill="#ffffff" opacity="0.95"/>
  <text x="300" y="120" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="32" font-weight="800">${escapeXml(b.appName)}</text>
  <text x="300" y="168" text-anchor="middle" fill="#ffffff" opacity="0.9" font-family="system-ui,sans-serif" font-size="18">Passbook cover preview</text>
  <text x="300" y="580" text-anchor="middle" fill="${escapeXml(b.primary)}" font-family="system-ui,sans-serif" font-size="22" font-weight="700">${escapeXml(b.businessName)}</text>
  <text x="300" y="620" text-anchor="middle" fill="#555" font-family="system-ui,sans-serif" font-size="15">Gold savings scheme</text>
  <text x="300" y="680" text-anchor="middle" fill="#777" font-family="system-ui,sans-serif" font-size="13">Colours shown as printed on passbook stock</text>
  <rect x="120" y="720" width="360" height="8" rx="4" fill="${escapeXml(b.accent)}"/>
</svg>`;

  return {
    appIcon: svgDataUrl(appIconSvg),
    receiptHeader: svgDataUrl(receiptSvg),
    passbookImage: svgDataUrl(passbookSvg),
  };
}
