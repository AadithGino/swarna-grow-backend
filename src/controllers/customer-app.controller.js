import { sendList, sendSuccess } from "../lib/response.js";
import * as customerApp from "../services/customer-app.service.js";
import { presignUpload } from "../services/upload.service.js";
import { mapCustomerPlanListItem } from "../lib/customer-app-dto.js";
import { validateEnrolmentResponse } from "../services/scheme.service.js";
import * as plans from "../services/plan.service.js";
import {
  paymentIntentAppDto,
  paymentLinkDto,
  paymentLinkSdkCheckoutDto,
} from "../lib/customer-app-dto.js";
import * as payments from "../services/payment.service.js";
import { PaymentPattern } from "../constants/enums.js";
import { Scheme } from "../models/index.js";
import { errors, AppError } from "../lib/app-error.js";

export const home = async (req, res) =>
  sendSuccess(res, await customerApp.buildHome(req.auth, req.tenant, req.query));

export const profile = async (req, res) =>
  sendSuccess(res, await customerApp.getAppProfile(req.auth, req.tenant));

export const completeProfile = async (req, res) =>
  sendSuccess(
    res,
    await customerApp.completeAppProfile(req.auth, req.body, {
      requireComplete: req.method === "POST",
    }),
  );

export const payableRange = async (req, res) =>
  sendSuccess(res, await customerApp.payableRangeForApp(req));

export const listSchemes = async (req, res) => {
  const result = await customerApp.listSchemesForApp(req);
  return sendList(res, result);
};

export const getScheme = async (req, res) =>
  sendSuccess(res, await customerApp.getSchemeDetailForApp(req));

export const listPayments = async (req, res) =>
  sendList(res, await customerApp.listPaymentsForApp(req));

export const listActivity = async (req, res) =>
  sendList(res, await customerApp.listActivityForApp(req));

export const getPayment = async (req, res) =>
  sendSuccess(res, await customerApp.getPaymentForApp(req));

export const listPlans = async (req, res) => {
  if (req.tenant?.operations?.customerSelfEnrolEnabled === false) {
    return sendList(res, { data: [], meta: { total: 0, limit: 0, offset: 0 } });
  }
  const result = await plans.listPlans(req, "app");
  const mapped = await Promise.all(
    result.data.map(async (plan) => {
      const fakeReq = {
        ...req,
        body: { customerId: req.auth.id, planId: plan._id },
      };
      let enrolCheck;
      try {
        enrolCheck = await validateEnrolmentResponse(fakeReq);
      } catch {
        enrolCheck = { canEnrol: false, blockers: [{ message: "Enrolment unavailable." }] };
      }
      return mapCustomerPlanListItem(plan, enrolCheck);
    }),
  );
  return sendList(res, { ...result, data: mapped });
};

export const getPlan = async (req, res) => {
  if (req.tenant?.operations?.customerSelfEnrolEnabled === false) {
    throw new AppError(
      "SELF_ENROL_DISABLED",
      "Self-enrolment is not available. Contact your branch to join a scheme.",
      403,
    );
  }
  const plan = await plans.getPlan(req);
  const enrolCheck = await validateEnrolmentResponse({
    ...req,
    body: { customerId: req.auth.id, planId: plan._id ?? plan.id },
  });
  return sendSuccess(res, mapCustomerPlanListItem(plan, enrolCheck));
};

export const presign = async (req, res) =>
  sendSuccess(res, await presignUpload(req), {}, 201);

export const updateNominee = async (req, res) => {
  req.params.customerId = req.auth.id;
  req.scope = { tenantId: req.auth.tenantId };
  const customers = await import("../services/customer.service.js");
  await customers.setNominee(req, false);
  return sendSuccess(res, await customerApp.getAppProfile(req.auth, req.tenant));
};

export const removeNominee = async (req, res) => {
  req.params.customerId = req.auth.id;
  req.scope = { tenantId: req.auth.tenantId };
  const customers = await import("../services/customer.service.js");
  await customers.setNominee(req, true);
  return sendSuccess(res, await customerApp.getAppProfile(req.auth, req.tenant));
};

export const paymentLinkStatus = async (req, res) =>
  sendSuccess(res, await customerApp.authenticatedLinkStatus(req.auth, req.params.linkId));

export const notifications = async (req, res) =>
  sendSuccess(res, await customerApp.listNotifications({ ...req.auth, limit: req.query.limit }));

export const fixedSchemePay = async (req, res) => {
  const scheme = await Scheme.findOne({
    _id: req.params.schemeId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!scheme) throw errors.notFound("Scheme");
  if (scheme.paymentPattern === PaymentPattern.FLEXIBLE) {
    throw new AppError(
      "FLEXIBLE_PAYMENT_INTENT_REQUIRED",
      "Flexible schemes must use payment intents.",
      422,
    );
  }
  req.body.schemeId = req.params.schemeId;
  req.scope = { tenantId: req.auth.tenantId, customerId: req.auth.id };
  const link = await payments.createPaymentLink(req);
  const base = paymentLinkDto({ ...link, _id: link.id }, link.token);
  if (req.body.redirectUrl) {
    const initiated = await payments.initiatePublicPayment({
      params: { linkToken: link.token },
      body: { redirectUrl: req.body.redirectUrl },
      headers: req.headers,
    });
    const hostedUrl = initiated.redirectUrl ?? initiated.paymentUrl ?? null;
    const sdkToken = initiated.token ?? null;
    const checkoutKind = hostedUrl ? "HOSTED_REDIRECT" : sdkToken ? "SDK_ORDER" : base.checkoutKind;
    return sendSuccess(
      res,
      {
        ...base,
        checkoutKind,
        provider: checkoutKind ? "PHONEPE" : base.provider,
        paymentUrl: hostedUrl ?? undefined,
        gatewayUrl: hostedUrl ?? base.gatewayUrl,
        token: sdkToken ?? undefined,
        sdkToken: sdkToken ?? undefined,
        paymentId: initiated.paymentId ?? base.transactionId,
        statusPollUrl: `/app/payments/${link.id}/status`,
      },
      {},
      201,
    );
  }
  return sendSuccess(res, base, {}, 201);
};

export const createIntent = async (req, res) => {
  const created = await payments.createPaymentIntent(req);
  return sendSuccess(
    res,
    paymentIntentAppDto(created, {
      redirectUrl: created.redirectUrl,
      token: created.token,
      paymentId: created.paymentId,
      providerOrderId: created.providerOrderId,
    }),
    {},
    201,
  );
};

export const createSdkOrder = async (req, res) => {
  const scheme = await Scheme.findOne({
    _id: req.params.schemeId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!scheme) throw errors.notFound("Scheme");
  if (scheme.paymentPattern === PaymentPattern.FLEXIBLE) {
    const created = await payments.createSdkPaymentIntent(req);
    return sendSuccess(
      res,
      paymentIntentAppDto(created, {
        token: created.token,
        merchantOrderId: created.merchantOrderId,
        paymentId: created.paymentId,
        providerOrderId: created.providerOrderId,
      }),
      {},
      201,
    );
  }
  if (scheme.paymentPattern === PaymentPattern.FIXED) {
    const created = await payments.createFixedSdkPayment(req);
    return sendSuccess(
      res,
      paymentLinkSdkCheckoutDto(
        {
          _id: created.paymentLinkId,
          schemeId: scheme._id,
          amountPaise: created.amountPaise,
          status: created.status,
          expiresAt: created.expiresAt,
          paymentId: created.paymentId,
          url: created.url,
        },
        created.linkToken,
        {
          sdkToken: created.sdkToken,
          merchantOrderId: created.merchantOrderId,
          providerOrderId: created.providerOrderId,
          paymentId: created.paymentId,
        },
      ),
      {},
      201,
    );
  }
  throw new AppError(
    "PAYMENT_PATTERN_UNSUPPORTED",
    "SDK checkout is supported only for fixed and flexible schemes.",
    422,
  );
};

export const getIntent = async (req, res) => {
  const { Payment, PaymentIntent, Scheme } = await import("../models/index.js");
  let intent = await PaymentIntent.findOne({
    _id: req.params.intentId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!intent) throw errors.notFound("Payment intent");
  let payment = intent.paymentId ? await Payment.findById(intent.paymentId).lean() : null;
  payment = await (
    await import("../services/payment.service.js")
  ).maybeCompleteMockGatewayPayment({
    tenantId: req.auth.tenantId,
    intent,
    payment,
  });
  if (
    payment?.status === "PENDING"
    && payment.mode === "ONLINE_GATEWAY"
  ) {
    try {
      const { reconcileGatewayPayment } = await import("../services/phonepe-reconcile.service.js");
      await reconcileGatewayPayment(payment, {
        source: "CUSTOMER_INTENT_POLL",
        leaseWorkerLabel: "customer-poll",
      });
      payment = (await Payment.findById(payment._id).lean()) ?? payment;
      intent = (await PaymentIntent.findById(intent._id).lean()) ?? intent;
    } catch {
      /* best-effort — same as shop / DM poll */
    }
  }
  if (payment?.status === "SUCCESS") {
    intent = (await PaymentIntent.findById(intent._id).lean()) ?? intent;
  }
  const scheme =
    payment?.status === "SUCCESS"
      ? await Scheme.findById(intent.schemeId).lean()
      : null;
  const { paymentIntentPollDto } = await import("../lib/customer-app-dto.js");
  return sendSuccess(res, {
    ...paymentIntentAppDto(intent, { paymentId: intent.paymentId ?? payment?._id }),
    ...paymentIntentPollDto({ intent, payment, scheme }),
  });
};
