/**
 * Counter trades: an admin or branch manager buys or sells Digi Gold for a customer in the shop.
 *
 * Buy  — quote at today's buy rate → customer pays at the counter (cash / UPI / card) → grams credited
 *        immediately, with the normal receipt + GST invoice. Cash is posted to the staff member's
 *        cash-in-hand.
 * Sell — quote at today's sell rate → grams reserved → order goes to the existing "To approve" queue.
 *        Payout is either the usual bank transfer (maker-checker) or cash at the counter, recorded here
 *        once the sell is approved.
 *
 * Every step reuses the customer services (pricing, terms, tax, ledger, outbox) through a
 * customer-bound request, so counter trades behave exactly like app trades.
 */
import { AppError, errors } from "../lib/app-error.js";
import { AuditEntityType } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import {
  assertCustomerCanTradeAtCounter,
  assistedMetadata,
  counterBranchId,
  counterStepKey,
  customerBoundRequest,
  postCounterCash,
} from "../lib/counter-trade.js";
import {
  Customer,
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalPayable,
  DigitalMetalPayout,
  DigitalMetalQuote,
  DigitalMetalSellOrder,
} from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { buildCustomerBuyQuote, createBuyOrder } from "./digital-metals-phase4.service.js";
import {
  finalizeDigitalMetalBuyPaymentSuccess,
  mapBuyOrderStatusDto,
} from "./digital-metals-buy-finalize.service.js";
import { createCustomerSellQuote, createSellOrder, mapSellOrderDto } from "./digital-metals-sell.service.js";
import { latestSettings } from "./digital-metals-phase2.service.js";
import { loadActiveBankDestinationForCustomer } from "./digital-metals-bank-destination.service.js";
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

function assertConsent(body) {
  if (body?.customerConsent !== true) {
    throw errors.validation([
      {
        field: "customerConsent",
        message: "Confirm the customer has seen the price and agreed to the terms.",
      },
    ]);
  }
}

async function loadAssistedQuote(req, customer, side) {
  const quote = await DigitalMetalQuote.findOne({
    _id: req.body.quoteId,
    tenantId: req.auth.tenantId,
    customerId: String(customer._id),
    side,
    quoteSource: "ASSISTED",
  }).lean();
  if (!quote) throw errors.notFound("Quote");
  return quote;
}

/* ───────────────────────── Buy ───────────────────────── */

export async function createAssistedBuyQuote(req) {
  const customer = await loadCounterCustomer(req);
  const inner = customerBoundRequest(req, customer, { body: req.body });
  const quote = await buildCustomerBuyQuote(inner, {
    quoteSource: "ASSISTED",
    createdBySubject: req.auth.id,
  });
  return { ...quote, customerId: String(customer._id) };
}

export async function placeAssistedBuy(req) {
  assertConsent(req.body);
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
  const quote = await loadAssistedQuote(req, customer, "BUY");

  const assisted = assistedMetadata(req, customer, {
    paymentMode,
    paymentReference,
    note: String(req.body.note ?? "").trim().slice(0, 500),
  });
  const orderDto = await createBuyOrder(
    customerBoundRequest(req, customer, {
      idempotencyKey: counterStepKey(req, "dm-buy"),
      body: {
        quoteId: quote._id,
        termsVersionAccepted: quote.termsVersion,
        termsContentHashAccepted: quote.termsContentHash,
      },
    }),
    { assisted },
  );
  const orderId = orderDto.id;
  const order = await DigitalMetalBuyOrder.findOne({ _id: orderId, tenantId: req.auth.tenantId }).lean();
  if (!order) throw errors.notFound("Order");

  const attemptKey = counterStepKey(req, "dm-buy-pay");
  let attempt = await DigitalMetalBuyPaymentAttempt.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey: attemptKey,
  }).lean();
  if (!attempt) {
    attempt = (
      await DigitalMetalBuyPaymentAttempt.create({
        _id: createId("dmpay"),
        tenantId: req.auth.tenantId,
        orderId,
        customerId: String(customer._id),
        status: "INITIATED",
        amountPaise: order.totalPayablePaise,
        provider: "COUNTER",
        checkoutMode: "COUNTER",
        merchantOrderId: `ctr_${orderId}`.slice(0, 64),
        idempotencyKey: attemptKey,
      })
    ).toObject();
  }

  const finalized = await finalizeDigitalMetalBuyPaymentSuccess({
    tenantId: req.auth.tenantId,
    merchantOrderId: attempt.merchantOrderId,
    transactionId: paymentReference || `COUNTER-${paymentMode}-${attempt._id}`,
    amountPaise: attempt.amountPaise,
    providerPayload: {
      channel: "COUNTER",
      paymentMode,
      paymentReference,
      recordedByUserId: req.auth.id,
    },
    source: "COUNTER",
  });
  if (!["CREDITED", "ALREADY_SUCCESS"].includes(finalized.outcome)) {
    throw new AppError(
      "COUNTER_BUY_NOT_CREDITED",
      "The payment was recorded but the grams could not be credited. Check the order in Digi Gold → Buy orders.",
      409,
      { outcome: finalized.outcome, orderId },
    );
  }

  let cashCustody = paymentMode === "CASH" ? "OWNER" : null;
  await withTransaction(async (session) => {
    if (paymentMode === "CASH") {
      const posted = await postCounterCash(session, {
        req,
        customer,
        direction: "CREDIT",
        amountPaise: order.totalPayablePaise,
        reason: `Digi Gold counter buy ${orderId}`,
        sourceType: "DM_COUNTER_BUY",
        sourceId: orderId,
      });
      cashCustody = posted.cashCustody;
      if (posted.cashAdjustmentId) {
        await DigitalMetalBuyOrder.updateOne(
          { _id: orderId, tenantId: req.auth.tenantId },
          { $set: { "assisted.cashAdjustmentId": posted.cashAdjustmentId } },
          { session },
        );
      }
    }
    await writeAudit({
      req,
      action: "DIGITAL_METAL_COUNTER_BUY",
      entityType: AuditEntityType.CUSTOMER,
      entityId: String(customer._id),
      after: {
        orderId,
        branchId: counterBranchId(req, customer),
        metal: order.metal,
        quantityUg: String(order.quantityUg),
        totalPayablePaise: order.totalPayablePaise,
        paymentMode,
      },
      session,
    });
  });

  const fresh = await DigitalMetalBuyOrder.findById(orderId).lean();
  const attempts = await DigitalMetalBuyPaymentAttempt.find({ tenantId: req.auth.tenantId, orderId }).lean();
  return { order: mapBuyOrderStatusDto(fresh, attempts), cashCustody };
}

/* ───────────────────────── Sell ───────────────────────── */

export async function createAssistedSellQuote(req) {
  const customer = await loadCounterCustomer(req);
  const inner = customerBoundRequest(req, customer, { body: req.body });
  const quote = await createCustomerSellQuote(inner, {
    quoteSource: "ASSISTED",
    createdBySubject: req.auth.id,
  });
  return { ...quote, customerId: String(customer._id) };
}

export async function placeAssistedSell(req) {
  assertConsent(req.body);
  const customer = await loadCounterCustomer(req);
  const payoutMethod = req.body.payoutMethod;
  const destinationId = String(req.body.bankDestinationId ?? "").trim();
  if (payoutMethod === "BANK") {
    if (!destinationId) {
      throw errors.validation([{ field: "bankDestinationId", message: "Choose the customer's verified bank account." }]);
    }
    await loadActiveBankDestinationForCustomer(req.auth.tenantId, String(customer._id), destinationId);
  }
  const quote = await loadAssistedQuote(req, customer, "SELL");
  const assisted = assistedMetadata(req, customer, {
    note: String(req.body.note ?? "").trim().slice(0, 500),
  });
  const created = await createSellOrder(
    customerBoundRequest(req, customer, {
      idempotencyKey: counterStepKey(req, "dm-sell"),
      body: {
        quoteId: quote._id,
        termsVersionAccepted: quote.termsVersion,
        termsContentHashAccepted: quote.termsContentHash,
      },
    }),
    { assisted, payoutMethod },
  );

  const settings = await latestSettings(req.auth.tenantId, quote.metal, quote.finenessPpm);
  const approvalExpiresAt = new Date(Date.now() + (settings?.sellApprovalTtlSeconds ?? 1800) * 1000);
  await DigitalMetalSellOrder.updateOne(
    { _id: created.id, tenantId: req.auth.tenantId, status: "RESERVED" },
    {
      $set: {
        status: "PENDING_APPROVAL",
        bankDestinationId: payoutMethod === "BANK" ? destinationId : null,
        confirmedAt: new Date(),
        approvalExpiresAt,
      },
    },
  );
  const order = await DigitalMetalSellOrder.findById(created.id).lean();
  if (!order || !["PENDING_APPROVAL", "PAYABLE_OPEN"].includes(order.status)) {
    throw new AppError("INVALID_STATE", "The sell could not be sent for approval.", 409, {
      status: order?.status ?? null,
    });
  }
  await writeAudit({
    req,
    action: "DIGITAL_METAL_COUNTER_SELL",
    entityType: AuditEntityType.CUSTOMER,
    entityId: String(customer._id),
    after: {
      orderId: order._id,
      branchId: counterBranchId(req, customer),
      metal: order.metal,
      quantityUg: String(order.quantityUg),
      settlementPaise: order.settlementPaise,
      payoutMethod,
    },
  });
  return { order: mapSellOrderDto(order) };
}

/** Pay an approved counter sell in cash. Settles the payable and debits the staff member's cash in hand. */
export async function recordSellCashPayout(req) {
  const order = await DigitalMetalSellOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Sell order");
  const customer = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, customer);
  if ((order.payoutMethod ?? "BANK") !== "CASH") {
    throw new AppError(
      "BANK_PAYOUT_ORDER",
      "This sell is paid by bank transfer. Use Digi Gold → Payouts.",
      409,
    );
  }
  if (order.status !== "PAYABLE_OPEN" || !order.payableId) {
    throw new AppError(
      "SELL_NOT_APPROVED",
      order.status === "PENDING_APPROVAL"
        ? "Approve the sell before paying the customer."
        : "This sell can no longer be paid.",
      409,
      { status: order.status },
    );
  }

  const result = await withTransaction(async (session) => {
    const payable = await DigitalMetalPayable.findOne({
      _id: order.payableId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!payable) throw errors.notFound("Payable");
    if (payable.status === "SETTLED") {
      return { payable: payable.toObject(), alreadyPaid: true, cashCustody: payable.cashPayout?.cashAdjustmentId ? "STAFF" : "OWNER" };
    }
    const bankPayout = await DigitalMetalPayout.findOne({
      tenantId: req.auth.tenantId,
      payableId: payable._id,
      status: { $ne: "FAILED" },
    })
      .session(session)
      .lean();
    if (bankPayout) {
      throw new AppError("PAYOUT_IN_PROGRESS", "A bank payout already exists for this sell.", 409);
    }
    const amountPaise = payable.outstandingPaise;
    const posted = await postCounterCash(session, {
      req,
      customer,
      direction: "DEBIT",
      amountPaise,
      reason: `Digi Gold counter sell payout ${order._id}`,
      sourceType: "DM_COUNTER_SELL_PAYOUT",
      sourceId: order._id,
    });
    const paidAt = new Date();
    const updated = await DigitalMetalPayable.findOneAndUpdate(
      { _id: payable._id, tenantId: req.auth.tenantId, status: "OPEN" },
      {
        $set: {
          outstandingPaise: 0,
          status: "SETTLED",
          settledAt: paidAt,
          settlementMethod: "CASH",
          cashPayout: {
            paidByUserId: req.auth.id,
            branchId: counterBranchId(req, customer),
            paidAt,
            receiptNote: String(req.body?.receiptNote ?? "").trim().slice(0, 500),
            cashAdjustmentId: posted.cashAdjustmentId,
          },
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("STATE_RACE", "Payable changed; refresh and retry.");
    await writeAudit({
      req,
      action: "DIGITAL_METAL_COUNTER_SELL_CASH_PAID",
      entityType: AuditEntityType.CUSTOMER,
      entityId: String(order.customerId),
      after: { orderId: order._id, payableId: payable._id, amountPaise, branchId: counterBranchId(req, customer) },
      session,
    });
    return { payable: updated.toObject(), alreadyPaid: false, cashCustody: posted.cashCustody };
  });

  return {
    order: mapSellOrderDto(order),
    payable: {
      id: result.payable._id,
      amountPaise: result.payable.amountPaise,
      outstandingPaise: result.payable.outstandingPaise,
      status: result.payable.status,
      settledAt: result.payable.settledAt ?? null,
      settlementMethod: result.payable.settlementMethod ?? null,
    },
    alreadyPaid: result.alreadyPaid,
    cashCustody: result.cashCustody,
  };
}
