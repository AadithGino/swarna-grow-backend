/** Strip spaces; keep leading + if present. */
export function cleanMobileInput(mobile) {
  if (mobile == null) return "";
  return String(mobile).replace(/\s/g, "").trim();
}

/** Canonical storage / lookup form aligned with customer validator. */
export function canonicalMobile(mobile) {
  const cleaned = cleanMobileInput(mobile);
  if (!cleaned) return cleaned;
  if (/^\+[1-9]\d{9,14}$/.test(cleaned)) return cleaned;
  if (/^[1-9]\d{9,14}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

/** All plausible stored variants for the same handset (India 10-digit common case). */
export function mobileLookupVariants(mobile) {
  const cleaned = cleanMobileInput(mobile);
  const variants = new Set();
  if (!cleaned) return [];

  variants.add(cleaned);
  variants.add(canonicalMobile(cleaned));

  const digits = cleaned.replace(/^\+/, "");
  if (/^[6-9]\d{9}$/.test(digits)) {
    variants.add(digits);
    variants.add(`+91${digits}`);
    variants.add(`91${digits}`);
  }
  if (cleaned.startsWith("+91") && cleaned.length === 13) {
    variants.add(cleaned.slice(3));
  }
  if (cleaned.startsWith("91") && cleaned.length === 12) {
    variants.add(`+${cleaned}`);
    variants.add(cleaned.slice(2));
  }

  return [...variants].filter(Boolean);
}

export function maskMobile(mobile) {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `******${digits.slice(-4)}`;
}

/** Last 10 digits for matching legacy stored mobiles in a tenant. */
export function mobileTenDigitSuffix(mobile) {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}
