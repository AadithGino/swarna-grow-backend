import { ulid } from "ulid";

const PREFIXES = Object.freeze({
  tenant: "tnt", user: "usr", customer: "cus", branch: "brn", plan: "spl", scheme: "sch",
  payment: "pay", paymentLink: "plk", paymentIntent: "pmi", ledger: "led", audit: "aud",
  handover: "csh", redemption: "red", message: "msg", grievance: "grv", upload: "upl",
  export: "exp", session: "ses", webhook: "whk", signup: "sgn", invoice: "inv",
  passwordReset: "prt", goldRate: "grt", grt: "grt", platformUser: "pusr",
  signupToken: "sgt", setupPassword: "spt", paymentSession: "psn", subscriptionPlan: "splan",
});

export function createId(kind) { return `${PREFIXES[kind] ?? kind}_${ulid()}`; }
