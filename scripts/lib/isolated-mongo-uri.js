/**
 * Allow only ephemeral/local MongoDB for ecommerce payment UI test runner.
 * Refuses Atlas, shared cloud, staging, and production-like URIs.
 */
export function assertIsolatedMongoUri(uri) {
  const raw = String(uri ?? "").trim();
  if (!raw) {
    throw new Error("MONGODB_URI is required for isolated runner validation.");
  }
  const lower = raw.toLowerCase();
  const blockedPatterns = [
    /mongodb\+srv:/,
    /\.mongodb\.net/,
    /mongodb\.net/,
    /\batlas\b/,
    /\.aws\./,
    /\bstaging\b/,
    /\bproduction\b/,
    /\bprod\b/,
    /\.prod\./,
  ];
  for (const pattern of blockedPatterns) {
    if (pattern.test(lower)) {
      throw new Error(
        `Refusing MongoDB URI (not isolated): ${raw.replace(/\/\/[^@]+@/, "//***@")}`,
      );
    }
  }
  let host;
  let dbName;
  try {
    const normalized = raw.replace(/^mongodb(\+srv)?:\/\//, "https://");
    const u = new URL(normalized);
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "").split("?")[0] || "";
  } catch {
    throw new Error("Invalid MONGODB_URI format.");
  }
  const localHost = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (!localHost) {
    throw new Error(
      `Refusing non-local MongoDB host "${host}". Use an in-memory replica set on loopback.`,
    );
  }
  if (dbName !== "swarnagrow_ecommerce_pay_ui") {
    throw new Error(
      `Refusing database "${dbName || "(default)"}" — use swarnagrow_ecommerce_pay_ui.`,
    );
  }
  return { host, dbName };
}
