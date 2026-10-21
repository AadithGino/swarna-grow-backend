/**
 * Ekta Gold Chitti — demo customers across lifecycle states (same matrix as one Aira collection plan).
 */
import { seedCollectionPlanMatrix } from "./seed-aira-gold-matrix.js";

const CHITTI_INSTALLMENT_PAISE = 300_000;

/**
 * @param {object} ctx
 * @param {{ plan: object, branchId: string, customers: object[] }} deps
 */
export async function seedEktaGoldChittiDemoMatrix(ctx, { plan, branchId, customers }) {
  const perPlan = 12;
  if (customers.length < perPlan) {
    throw new Error(`Need at least ${perPlan} demo customers, got ${customers.length}`);
  }
  console.log("[ekta-gold-chitti seed] Gold Chitti (12m, 11+1) lifecycle matrix…");
  return seedCollectionPlanMatrix(ctx, {
    plan,
    planLabel: "GOLDCHITTI",
    branchId,
    customers: customers.slice(0, perPlan),
    installmentAmountPaise: CHITTI_INSTALLMENT_PAISE,
  });
}
