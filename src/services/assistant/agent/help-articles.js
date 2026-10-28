/**
 * Product help for "how do I…" questions. Kept at the level of where things live in
 * the owner portal (menu → page) so it stays true as screens evolve.
 */
export const HELP_ARTICLES = Object.freeze([
  {
    id: "add-customer",
    title: "Add a new customer",
    keywords: ["customer", "add", "new", "register", "create", "member"],
    body:
      "Go to Customer operations → Customers and create the customer with their name and mobile number. Collection agents can also register customers from the agent app (New customer). The customer then signs in to your branded app with the same mobile number.",
  },
  {
    id: "enrol-scheme",
    title: "Enrol a customer in a scheme",
    keywords: ["enrol", "enroll", "enrolment", "join", "scheme", "plan", "chitti", "kuri"],
    body:
      "Open the customer from Customer operations → Customers and enrol them in one of your active plans. All enrolments are listed under Customer operations → Enrollments, where you can open one to see its instalment schedule.",
  },
  {
    id: "collect-payment",
    title: "Record a scheme payment",
    keywords: ["payment", "collect", "receipt", "record", "instalment", "installment", "cash", "upi"],
    body:
      "Open the enrolment (Customer operations → Enrollments) or the customer and use Collect payment to record cash, UPI, card or bank transfer. A receipt is created immediately. Collection agents record payments from the agent app. Customers can also pay online from your app.",
  },
  {
    id: "dues",
    title: "See overdue and upcoming dues",
    keywords: ["due", "dues", "overdue", "defaulter", "pending", "late", "reminder"],
    body:
      "Customer operations → Dues lists instalments that are due or overdue. You can also ask me \"who is overdue this month\" for a list, or use Engagement & insight → Reminder centre to remind customers through the app.",
  },
  {
    id: "scheme-plans",
    title: "Create or change a scheme plan",
    keywords: ["scheme", "plan", "create", "new plan", "builder", "bonus", "benefit", "duration"],
    body:
      "Configuration → Schemes is the scheme builder: create a New scheme plan with fixed or flexible payments, cash or gold-weight value, duration, bonus/benefit and redemption rules, then activate it so it can be offered.",
  },
  {
    id: "gold-rate",
    title: "Update today's gold rate",
    keywords: ["gold rate", "rate", "price", "publish", "22k", "today rate"],
    body:
      "Money & fulfilment → Gold rates is where you set the scheme gold rate (Set rate). The online store has its own rate under Online store → Store gold rates.",
  },
  {
    id: "redemption",
    title: "Handle maturity and redemption",
    keywords: ["maturity", "matured", "redeem", "redemption", "closure", "close", "premature", "settlement"],
    body:
      "Money & fulfilment → Maturity & redemption shows the maturity list and the redemption queue. Approve and complete redemptions there (cash payout, gold handover or purchase adjustment). Customers can also request redemption from the app.",
  },
  {
    id: "cash-control",
    title: "Cash handovers from staff",
    keywords: ["cash", "handover", "custody", "agent cash", "cash in hand", "reconcile"],
    body:
      "Money & fulfilment → Cash control shows cash in hand per staff member, pending handovers and discrepancies. Accept or settle handovers there.",
  },
  {
    id: "reminders",
    title: "Send reminders or announcements",
    keywords: ["reminder", "notify", "notification", "push", "message", "broadcast", "announce"],
    body:
      "Engagement & insight → Reminder centre controls automated due reminders and lets you send a manual push message to customers through your branded app.",
  },
  {
    id: "digi-gold",
    title: "Digi Gold (digital gold and silver)",
    keywords: ["digi gold", "digital gold", "digital silver", "buy gold", "sell gold", "wallet", "metals"],
    body:
      "Digital metals → Workspace is where you configure Digi Gold, review customer buy and sell orders, approvals, payouts and redemptions of digital metal.",
  },
  {
    id: "store",
    title: "Online store: products and orders",
    keywords: ["store", "ecommerce", "product", "catalog", "order", "shop online", "inventory", "banner", "cod"],
    body:
      "Online store → Catalog holds products (with categories, banners, inventory, tax and fulfilment settings alongside). Store operations → Orders is where you process orders, and Courier COD tracks cash-on-delivery remittances.",
  },
  {
    id: "staff",
    title: "Add staff or branches",
    keywords: ["staff", "employee", "user", "agent", "branch", "showroom", "role", "permission", "manager"],
    body:
      "Configuration → Staff & branches is where you add showrooms and staff, and assign roles: owner, admin, branch manager, branch staff or collection agent.",
  },
  {
    id: "reports",
    title: "Reports and exports",
    keywords: ["report", "export", "excel", "csv", "pdf", "download", "statement"],
    body:
      "Engagement & insight → Reports has every standard report (collections, outstanding, enrolments, staff performance, maturity, gold liability and more) with export. Any table I show you here also has an Export button for Excel or CSV.",
  },
  {
    id: "audit",
    title: "Who changed what",
    keywords: ["audit", "log", "history", "who changed", "who edited", "timeline"],
    body: "Configuration → Audit timeline records who did what and when across the portal.",
  },
  {
    id: "settings",
    title: "Shop settings and app branding",
    keywords: ["settings", "brand", "logo", "app", "subscription", "plan upgrade", "profile"],
    body: "Configuration → Settings holds your shop profile, branding for the customer app and subscription details.",
  },
  {
    id: "sidekick",
    title: "What Sidekick can do",
    keywords: ["sidekick", "assistant", "ai", "what can you do", "help", "how to use"],
    body:
      "Ask about anything in your Swarna Grow data in your own words — collections, payments by mode, overdue customers, enrolments, maturities, staff, branches, Digi Gold and store orders. Answers come from your live data and can be exported. I can't make changes (like recording payments) yet.",
  },
]);

export function searchHelp(query, limit = 3) {
  const q = String(query ?? "").toLowerCase();
  if (!q.trim()) return HELP_ARTICLES.slice(0, limit);
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = HELP_ARTICLES.map((a) => {
    let score = 0;
    for (const k of a.keywords) {
      if (q.includes(k)) score += k.includes(" ") ? 4 : 3;
    }
    const hay = `${a.title} ${a.body}`.toLowerCase();
    for (const w of words) if (hay.includes(w)) score += 1;
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
  return scored.map((x) => x.a);
}
