/**
 * Which provider order a payment attempt currently stands for. A provider status answer is only
 * valid for the identity it was requested under: if the attempt has since been pointed at another
 * provider order, the answer must be discarded rather than applied.
 */
const norm = (value) => (value === undefined || value === null ? "" : String(value));

/** Raw identity, as stored, so it can be used directly as a write condition. */
export const attemptIdentity = (attempt) => ({
  provider: attempt.provider ?? null,
  merchantOrderId: attempt.merchantOrderId ?? null,
  providerOrderId: attempt.providerOrderId ?? null,
});

export const sameIdentity = (a, b) =>
  norm(a?.provider) === norm(b?.provider)
  && norm(a?.merchantOrderId) === norm(b?.merchantOrderId)
  && norm(a?.providerOrderId) === norm(b?.providerOrderId);

/** Query condition pinning a write to an identity; empty when no identity was expected. */
export const identityFilter = (identity) =>
  identity
    ? {
        provider: identity.provider ?? null,
        merchantOrderId: identity.merchantOrderId ?? null,
        providerOrderId: identity.providerOrderId ?? null,
      }
    : {};

export const IDENTITY_CHANGED = "IDENTITY_CHANGED";
