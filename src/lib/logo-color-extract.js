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
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(96, 96, { fit: "cover" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map();
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3] ?? 255;
      if (a < 100) continue;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // Skip near-white backgrounds and pure black speckle; keep navy / maroon brand marks.
      if (lum > 248 || lum < 4) continue;
      const key = `${(r >> 4) * 17},${(g >> 4) * 17},${(b >> 4) * 17}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const ranked = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
    const palette = ranked
      .map((entry) => {
        const [rs, gs, bs] = entry[0].split(",").map(Number);
        return { hex: toHex(rs, gs, bs), r: rs, g: gs, b: bs, count: entry[1] };
      })
      .filter((c) => luminanceRgb(c.r, c.g, c.b) <= 220);

    const primaryColor = palette[0]?.hex ?? DEFAULTS.primaryColor;
    const primaryRgb = hexToRgb(primaryColor) ?? hexToRgb(DEFAULTS.primaryColor);
    let accentColor = null;
    for (let i = 1; i < palette.length; i += 1) {
      const c = palette[i];
      const dr = c.r - primaryRgb[0];
      const dg = c.g - primaryRgb[1];
      const db = c.b - primaryRgb[2];
      if (Math.hypot(dr, dg, db) >= 32) {
        accentColor = c.hex;
        break;
      }
    }
    accentColor ??= palette.length <= 1 ? mixWithWhite(primaryColor, 0.45) : DEFAULTS.accentColor;
    const splashBackgroundColor = mixWithWhite(primaryColor, 0.93);
    return { primaryColor, accentColor, splashBackgroundColor };
  } catch {
    return { ...DEFAULTS };
  }
}

export function parseLogoDataUrlBuffer(dataUrl) {
  return parseDataUrl(dataUrl);
}