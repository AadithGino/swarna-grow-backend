/**
 * Store orders placed by staff for a customer at the counter (admin / branch manager).
 *
 * options → what the customer can choose (pickup branches, saved delivery addresses, readiness)
 * quote   → price the chosen products at today's rates (reserves stock for the quote window)
 * order   → customer pays at the counter (cash / UPI / card); the order is created and marked PAID in
 *           one go, stock is consumed and the normal invoice/notification outbox runs. Cash is posted
 *           to the staff member's cash in hand.
 *
 * Pricing, tax, stock and fulfilment rules come from the customer checkout services unchanged.
 */
import { AppError, errors } from "../lib/app-error.js";
import { AuditEntityType } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import { customerFulfilmentOptions, mapFulfilmentSettings } from "../lib/ecommerce-fulfilment.js";
import {
  assertCustomerCanTradeAtCounter,
  assistedMetadata,
  counterBranchId,
  counterStepKey,
  customerBoundRequest,
  postCounterCash,
} from "../lib/counter-trade.js";
import {
  Branch,
  Customer,
  EcommerceCustomerAddress,
  EcommerceFulfilmentSettings,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePriceQuote,
  EcommerceTaxSettings,
} from "../models/index.js";
import { evaluateCheckoutTaxReadiness } from "../lib/ecommerce-checkout-tax.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { createCustomerQuote } from "./ecommerce-quote.service.js";
import { createCustomerOrder, getAdminOrder } from "./ecommerce-order.service.js";
import { finalizeEcommercePaymentSuccess } from "./ecommerce-payment-finalize.service.js";
import { writeAudit } from "./audit.service.js";

async function loadCounterCustomer(req) {
  const customer = await Customer.findOne({
    _id: req.params.customerId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!customer) throw errors.notFound("Customer");
  assertTenantOwnsCustomerScope(req, customer);
  assertCustomerCanTradeAtCounter(customer);
  return customer;
}

function mapAddress(row) {
  return {
    id: row._id,
    label: row.label ?? "",
    recipientName: row.recipientName ?? "",
    line1: row.line1,
    line2: row.line2 ?? "",
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    isDefault: row.isDefault === true,
  };
}

export async function getAssistedOrderOptions(req) {
  assertEcommerceOperational(req.tenant);
  const customer = await loadCounterCustomer(req);
  const [settings, taxSettings, addresses] = await Promise.all([
    EcommerceFulfilmentSettings.findOne({ tenantId: req.auth.tenantId }).lean(),
    EcommerceTaxSettings.findOne({ tenantId: req.auth.tenantId }).lean(),
    EcommerceCustomerAddress.find({ tenantId: req.auth.tenantId, customerId: String(customer._id) })
      .sort({ isDefault: -1, updatedAt: -1 })
      .limit(20)
      .lean(),
  ]);
  const mapped = mapFulfilmentSettings(settings ?? {});
  const branches = mapped.pickupBranchIds.length
    ? await Branch.find({
        tenantId: req.auth.tenantId,
        _id: { $in: mapped.pickupBranchIds },
        active: { $ne: false },
      })
        .select("_id name code")
        .lean()
    : [];
  const options = customerFulfilmentOptions(settings ?? {}, branches.map((b) => ({ ...b, id: b._id })));
  const readiness = evaluateCheckoutTaxReadiness(taxSettings, settings ?? {});
  const myBranch = counterBranchId(req, customer);
  const pickupIds = options.pickup.branches.map((b) => b.id);
  return {
    customerId: String(customer._id),
    pickup: options.pickup,
    delivery: { enabled: options.delivery.enabled, deliveryChargePaise: options.delivery.deliveryChargePaise },
    defaultPickupBranchId: pickupIds.includes(myBranch) ? myBranch : (pickupIds[0] ?? null),
    addresses: addresses.map(mapAddress),
    checkoutTaxReady: readiness.ready,
    blockers: readiness.ready ? [] : readiness.blockers ?? [],
    paymentModes: ["CASH", "UPI", "CARD"],
  };
}

export async function createAssistedOrderQuote(req) {
  const customer = await loadCounterCustomer(req);
  const lines = (req.body.lines ?? []).map((l) => ({ productId: String(l.productId), quantity: Number(l.quantity) }));
  const merged = new Map();
  for (const line of lines) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);
  const inner = customerBoundRequest(req, customer, {
    idempotencyKey: counterStepKey(req, "eq"),
    body: {
      fulfilmentMode: req.body.fulfilmentMode,
      pickupBranchId: req.body.pickupBranchId,
      addressId: req.body.addressId,
      paymentMethod: "ONLINE",
    },
  });
  const { quote } = await createCustomerQuote(inner, {
    lines: [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity })),
    assistedByUserId: req.auth.id,
  });
  return {
    id: quote.id,
    status: quote.status,
    lines: quote.lines,
    fulfilmentMode: quote.fulfilmentMode,
    pickupBranchId: quote.pickupBranchId,
    addressSnapshot: quote.addressSnapshot,
    subtotalPaise: quote.subtotalPaise,
    taxPaise: quote.taxPaise,
    fulfilmentChargePaise: quote.fulfilmentChargePaise,
    totalPaise: quote.totalPaise,
    taxComponentLines: quote.taxComponentLines,
    expiresAt: quote.expiresAt,
    customerId: String(customer._id),
  };
}

export async function placeAssistedOrder(req) {
  if (req.body?.customerConsent !== true) {
    throw errors.validation([
      { field: "customerConsent", message: "Confirm the customer has agreed to the items and total." },
    ]);
  }
  const customer = await loadCounterCustomer(req);
  const paymentMode = req.body.paymentMode;
  const paymentReference = String(req.body.paymentReference ?? "").trim();
  if (paymentMode !== "CASH" && paymentReference.length < 4) {
    throw errors.validation([
      {
        field: "paymentReference",
        message: paymentMode === "UPI" ? "Enter the UPI reference (UTR) from the payment." : "Enter the card slip or approval number.",
      },
    ]);
  }
  const quote = await EcommercePriceQuote.findOne({
    _id: req.body.quoteId,
    tenantId: req.auth.tenantId,
    customerId: String(customer._id),
  }).lean();
  if (!quote || !quote.assistedByUserId) throw errors.notFound("Quote");

  const assisted = assistedMetadata(req, customer, {
    paymentMode,
    paymentReference,
    note: String(req.body.note ?? "").trim().slice(0, 500),
  });
  const { order: created } = await createCustomerOrder(
    customerBoundRequest(req, customer, {
      idempotencyKey: counterStepKey(req, "eo"),
      body: { quoteId: quote._id },
    }),
    { assisted },
  );
  const orderId = created.id;
  const order = await EcommerceOrder.findOne({ _id: orderId, tenantId: req.auth.tenantId }).lean();
  if (!order) throw errors.notFound("Order");

  const attemptKey = counterStepKey(req, "eo-pay");
  let attempt = await EcommercePaymentAttempt.findOne({ tenantId: req.auth.tenantId, idempotencyKey: attemptKey }).lean();
  if (!attempt && order.status === "PENDING_PAYMENT") {
    attempt = (
      await EcommercePaymentAttempt.create({
        _id: createId("epay"),
        tenantId: req.auth.tenantId,
        orderId,
        customerId: String(customer._id),
        status: "INITIATED",
        amountPaise: order.totalPaise,
        provider: "COUNTER",
        merchantOrderId: `ctr_${orderId}`.slice(0, 80),
        idempotencyKey: attemptKey,
        providerPayload: { channel: "COUNTER", paymentMode, paymentReference },
      })
    ).toObject();
  }
  if (attempt) {
    const finalized = await finalizeEcommercePaymentSuccess({
      tenantId: req.auth.tenantId,
      merchantOrderId: attempt.merchantOrderId,
      transactionId: paymentReference || `COUNTER-${paymentMode}-${attempt._id}`,
      amountPaise: attempt.amountPaise,
      providerPayload: { channel: "COUNTER", paymentMode, paymentReference, recordedByUserId: req.auth.id },
      source: "COUNTER",
    });
    if (!["SUCCESS", "ALREADY_SUCCESS"].includes(finalized.outcome)) {
      throw new AppError(
        "COUNTER_ORDER_NOT_PAID",
        "The order was created but could not be marked paid. Open it in Store → Orders.",
        409,
        { outcome: finalized.outcome, orderId },
      );
    }
  } else if (order.status !== "PAID") {
    throw new AppError("COUNTER_ORDER_NOT_PAID", "This order is not awaiting payment.", 409, {
      status: order.status,
      orderId,
    });
  }

  let cashCustody = paymentMode === "CASH" ? "OWNER" : null;
  await withTransaction(async (session) => {
    if (paymentMode === "CASH") {
      const posted = await postCounterCash(session, {
        req,
        customer,
        direction: "CREDIT",
        amountPaise: order.totalPaise,
        reason: `Store counter order ${order.orderNumber}`,
        sourceType: "ECOMMERCE_COUNTER_ORDER",
        sourceId: orderId,
      });
      cashCustody = posted.cashCustody;
      if (posted.cashAdjustmentId) {
        await EcommerceOrder.updateOne(
          { _id: orderId, tenantId: req.auth.tenantId },
          { $set: { "assisted.cashAdjustmentId": posted.cashAdjustmentId } },
          { session },
        );
      }
    }
    await writeAudit({
      req,
      action: "ECOMMERCE_COUNTER_ORDER",
      entityType: AuditEntityType.CUSTOMER,
      entityId: String(customer._id),
      after: {
        orderId,
        orderNumber: order.orderNumber,
        branchId: counterBranchId(req, customer),
        totalPaise: order.totalPaise,
        paymentMode,
        lines: (order.lines ?? []).map((l) => ({ productId: l.productId, quantity: l.quantity })),
      },
      session,
    });
  });

  const adminOrder = await getAdminOrder({
    auth: req.auth,
    tenant: req.tenant,
    scope: req.scope,
    params: { orderId },
    query: {},
    headers: {},
  });
  return { order: adminOrder, cashCustody };
}
