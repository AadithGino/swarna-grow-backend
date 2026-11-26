import sharp from "sharp";

const DEFAULTS = Object.freeze({
  primaryColor: "#730321",
  accentColor: "#C9A227",
  splashBackgroundColor: "#fbf1f3",
});

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex(r, g, b) {
  return `#${[r, g, b].map((c) => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

function luminanceRgb(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function hexToRgb(hex) {
  const raw = String(hex).replace("#", "");
  if (raw.length !== 6) return null;
  return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
}

function mixWithWhite(hex, whiteWeight = 0.9) {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return DEFAULTS.splashBackgroundColor;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return toHex(
    r * (1 - whiteWeight) + 255 * whiteWeight,
    g * (1 - whiteWeight) + 255 * whiteWeight,
    b * (1 - whiteWeight) + 255 * whiteWeight,
  );
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl ?? "").trim());
  if (!match) return null;
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") };
}

function buildPalette(data, info, { includeNeutrals = false } = {}) {
  const buckets = new Map();
  let opaque = 0;
  let darkPixels = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3] ?? 255;
    if (a < 100) continue;
    opaque += 1;
    const lum = luminanceRgb(r, g, b);
    if (lum < 28) darkPixels += 1;
    if (!includeNeutrals && (lum > 248 || lum < 4)) continue;
    const key = `${(r >> 4) * 17},${(g >> 4) * 17},${(b >> 4) * 17}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const palette = ranked.map((entry) => {
    const [rs, gs, bs] = entry[0].split(",").map(Number);
    return {
      hex: toHex(rs, gs, bs),
      r: rs,
      g: gs,
      b: bs,
      count: entry[1],
      lum: luminanceRgb(rs, gs, bs),
    };
  });
  const darkRatio = opaque ? darkPixels / opaque : 0;
  return { palette, darkRatio };
}

function isWarmGold(c) {
  return c.r >= c.g && c.g >= c.b && c.lum >= 90 && c.lum <= 215 && c.r - c.b >= 24;
}

/** Dominant colours from logo bytes (or data URL) for demo branding. */
export async function extractBrandColorsFromImageInput(input) {
  let buffer = Buffer.isBuffer(input) ? input : null;
  if (!buffer && typeof input === "string") {
    const parsed = parseDataUrl(input);
    buffer = parsed?.buffer ?? null;
  }
  if (!buffer?.length) return { ...DEFAULTS };

  try {
    const { data, info } = await sharp(buffer)
      .resize(128, 128, { fit: "cover" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { palette: rawPalette, darkRatio } = buildPalette(data, info, { includeNeutrals: true });
    const palette = rawPalette.filter((c) => c.lum <= 245);

    if (darkRatio >= 0.12) {
      const gold = palette
        .filter(isWarmGold)
        .sort((a, b) => b.count - a.count)[0];
      const dark = palette
        .filter((c) => c.lum <= 36)
        .sort((a, b) => b.count - a.count)[0];
      const primaryColor = gold?.hex ?? palette.find((c) => c.lum <= 220)?.hex ?? DEFAULTS.primaryColor;
      const accentColor = gold && dark ? "#ffffff" : gold?.hex ?? DEFAULTS.accentColor;
      const splashBackgroundColor = dark?.hex ?? "#0d0d0d";
      return { primaryColor, accentColor, splashBackgroundColor };
    }

    const brandPalette = palette.filter((c) => c.lum <= 220);
    const primaryColor = brandPalette[0]?.hex ?? DEFAULTS.primaryColor;
    const primaryRgb = hexToRgb(primaryColor) ?? hexToRgb(DEFAULTS.primaryColor);
    let accentColor = null;
    for (let i = 1; i < brandPalette.length; i += 1) {
      const c = brandPalette[i];
      const dr = c.r - primaryRgb[0];
      const dg = c.g - primaryRgb[1];
      const db = c.b - primaryRgb[2];
      if (Math.hypot(dr, dg, db) >= 32) {
        accentColor = isWarmGold(c) ? c.hex : c.hex;
        break;
      }
    }
    if (!accentColor) {
      const gold = brandPalette.find(isWarmGold);
      accentColor = gold?.hex ?? (brandPalette.length <= 1 ? mixWithWhite(primaryColor, 0.45) : DEFAULTS.accentColor);
    }
    const splashBackgroundColor =
      primaryColor && luminanceRgb(...primaryRgb) < 80
        ? mixWithWhite(primaryColor, 0.88)
        : mixWithWhite(primaryColor, 0.93);
    return { primaryColor, accentColor, splashBackgroundColor };
  } catch {
    return { ...DEFAULTS };
  }
}

export function parseLogoDataUrlBuffer(dataUrl) {
  return parseDataUrl(dataUrl);
}