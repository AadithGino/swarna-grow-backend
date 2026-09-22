#!/usr/bin/env node
/**
 * Real DB portal action matrix:
 * - validates all OPS operation combinations through customer-app actions
 * - validates KAIRALI customer settlement-preview modes + redemption request path
 * - validates nominee and KYC behavior against tenant settings
 *
 * Usage: node --env-file=.env scripts/audit-realdb-portal-action-matrix.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Customer, Redemption, Scheme, Tenant } from "../src/models/index.js";
import { randomUUID } from "node:crypto";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const PASSWORD = "2026";
const DEVICE_ID = "portal-action-matrix";

let pass = 0;
let fail = 0;
const failures = [];

function ok(msg) {
  pass += 1;
  console.log(`\u2713 ${msg}`);
}

function bad(msg) {
  fail += 1;
  failures.push(msg);
  console.error(`\u2717 ${msg}`);
}

function moneyAmount(ref) {
  return ref?.amountPaise ?? null;
}

async function api(method, path, { token, body, query } = {}) {
  const params = new URLSearchParams(query ?? {});
  const url = `${BASE}${path}${params.toString() ? `?${params.toString()}` : ""}`;
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
    headers["x-idempotency-key"] = randomUUID();
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let jsonBody;
  try {
    jsonBody = await res.json();
  } catch {
    jsonBody = null;
  }
  return { ok: res.ok, status: res.status, body: jsonBody, url };
}

function dataOf(res) {
  return res.body?.data ?? res.body ?? {};
}

async function customerPasswordLogin(tenantCode, mobile) {
  const res = await api("POST", "/public/auth/login-password", {
    body: { tenantCode, mobile, password: PASSWORD, deviceId: DEVICE_ID },
  });
  return res;
}

async function customerOtpLogin(tenantCode, mobile) {
  const req = await api("POST", "/public/auth/otp/request", {
    body: { tenantCode, mobile, purpose: "LOGIN", deviceId: DEVICE_ID },
  });
  if (!req.ok) return req;
  const otpId = dataOf(req)?.otpId;
  return api("POST", "/public/auth/otp/verify", {
    body: {
      tenantCode,
      mobile,
      purpose: "LOGIN",
      deviceId: DEVICE_ID,
      otp: "123456",
      otpId,
    },
  });
}

async function customerLogin(tenantCode, mobile) {
  const byPassword = await customerPasswordLogin(tenantCode, mobile);
  if (byPassword.ok) return byPassword;
  const byOtp = await customerOtpLogin(tenantCode, mobile);
  if (byOtp.ok) return byOtp;
  return byPassword;
}

function expectedCapabilities(tenant) {
  const ops = tenant.operations ?? {};
  const settings = tenant.settings ?? {};
  const oneSchemeOnly =
    settings.oneActiveSchemePerCustomer === true || ops.multiSchemePerCustomer === false;
  return {
    customerSelfEnrol: ops.customerSelfEnrolEnabled !== false,
    customerSelfRegistration: ops.customerSelfRegistrationEnabled !== false,
    kycMandatory: Boolean(settings.requireKycForEnrolment),
    multiScheme: !oneSchemeOnly,
    customerLoginMode: ops.customerLoginMode ?? "OTP_ONLY",
    customerAppWriteEnabled: ops.customerAppWriteEnabled !== false,
    customerAppPaymentsEnabled:
      ops.customerAppWriteEnabled !== false && ops.customerAppPaymentsEnabled !== false,
  };
}

async function verifyOpsTenant(tenant, customer) {
  const login = await customerLogin(tenant.code, customer.mobile);
  if (!login.ok) {
    bad(`${tenant.code}: customer login failed (${login.status})`);
    return;
  }
  const session = dataOf(login);
  const token = session.accessToken;
  const expected = expectedCapabilities(tenant);
  const got = session.tenantCapabilities ?? {};

  for (const key of Object.keys(expected)) {
    if (got[key] !== expected[key]) {
      bad(`${tenant.code}: tenantCapabilities.${key} expected=${expected[key]} got=${got[key]}`);
    } else {
      ok(`${tenant.code}: tenantCapabilities.${key}`);
    }
  }

  const profile = await api("GET", "/app/profile", { token });
  if (!profile.ok) {
    bad(`${tenant.code}: GET /app/profile failed (${profile.status})`);
    return;
  }
  const profileData = dataOf(profile);
  const hasKyc = Object.prototype.hasOwnProperty.call(profileData, "kyc");
  const expectKyc = Boolean(tenant.settings?.requireKycForEnrolment);
  if (hasKyc !== expectKyc) {
    bad(`${tenant.code}: profile.kyc presence expected=${expectKyc} got=${hasKyc}`);
  } else {
    ok(`${tenant.code}: profile.kyc presence`);
  }

  const patchProfile = await api("PATCH", "/app/profile", {
    token,
    body: { address: `OPS audit ${tenant.code}`, expectedVersion: profileData.version },
  });
  const canWrite = expected.customerAppWriteEnabled;
  if (canWrite) {
    if (patchProfile.ok) ok(`${tenant.code}: PATCH /app/profile allowed`);
    else bad(`${tenant.code}: PATCH /app/profile expected allowed, got ${patchProfile.status}`);
  } else {
    const code = patchProfile.body?.error?.code;
    if (patchProfile.status === 403 && code === "CUSTOMER_APP_VIEW_ONLY") {
      ok(`${tenant.code}: PATCH /app/profile blocked as view-only`);
    } else {
      bad(`${tenant.code}: PATCH /app/profile expected CUSTOMER_APP_VIEW_ONLY, got ${patchProfile.status}/${code ?? "n/a"}`);
    }
  }
  const latestVersion = patchProfile.ok ? (dataOf(patchProfile)?.version ?? profileData.version) : profileData.version;

  const nomineeReq = await api("PUT", "/app/profile/nominee", {
    token,
    body: {
      name: "Audit Nominee",
      relationship: "SPOUSE",
      mobile: "+919999999901",
      address: "Audit Street",
      expectedVersion: latestVersion,
    },
  });

  if (canWrite) {
    if (!nomineeReq.ok) {
      bad(`${tenant.code}: nominee PUT failed (${nomineeReq.status})`);
    } else {
      ok(`${tenant.code}: nominee PUT`);
      const nomineeProfile = dataOf(nomineeReq);
      const del = await api("DELETE", "/app/profile/nominee", {
        token,
        body: { expectedVersion: nomineeProfile.version },
      });
      if (del.ok) ok(`${tenant.code}: nominee DELETE`);
      else bad(`${tenant.code}: nominee DELETE failed (${del.status})`);
    }
  } else {
    const code = nomineeReq.body?.error?.code;
    if (nomineeReq.status === 403 && code === "CUSTOMER_APP_VIEW_ONLY") {
      ok(`${tenant.code}: nominee PUT blocked as view-only`);
    } else {
      bad(`${tenant.code}: nominee PUT expected CUSTOMER_APP_VIEW_ONLY, got ${nomineeReq.status}/${code ?? "n/a"}`);
    }
  }

  const kycReq = await api("PUT", "/app/profile/kyc", {
    token,
    body: {
      type: "AADHAAR",
      numberMasked: "XXXX-XXXX-9012",
    },
  });
  if (!canWrite) {
    const code = kycReq.body?.error?.code;
    if (kycReq.status === 403 && code === "CUSTOMER_APP_VIEW_ONLY") {
      ok(`${tenant.code}: KYC blocked as view-only`);
    } else {
      bad(`${tenant.code}: KYC expected CUSTOMER_APP_VIEW_ONLY, got ${kycReq.status}/${code ?? "n/a"}`);
    }
  } else if (expectKyc) {
    if (kycReq.ok) ok(`${tenant.code}: KYC submit allowed`);
    else bad(`${tenant.code}: KYC submit expected allowed, got ${kycReq.status}`);
  } else {
    const code = kycReq.body?.error?.code;
    if (kycReq.status === 403 && code === "KYC_NOT_ENABLED") ok(`${tenant.code}: KYC blocked when disabled`);
    else bad(`${tenant.code}: KYC expected KYC_NOT_ENABLED, got ${kycReq.status}/${code ?? "n/a"}`);
  }

  const schemesRes = await api("GET", "/app/schemes", { token, query: { limit: "20" } });
  const schemePayload = dataOf(schemesRes);
  const schemeRows = Array.isArray(schemePayload)
    ? schemePayload
    : schemePayload?.data ?? schemePayload?.rows ?? [];
  const fixed = schemeRows.find((row) => row.displayMode === "FIXED" || row.paymentPattern === "FIXED");
  if (!fixed) {
    bad(`${tenant.code}: no fixed scheme found for pay check`);
    return;
  }
  const pr = await api("GET", `/app/schemes/${fixed.id}/payable-range`, { token });
  const amount = Math.max(10_000, moneyAmount(dataOf(pr)?.suggested) ?? moneyAmount(dataOf(pr)?.minPayable) ?? 10_000);
  const payReq = await api("POST", `/app/schemes/${fixed.id}/pay`, {
    token,
    body: {
      amountPaise: amount,
      redirectUrl: "https://customer.example.com/pay/status",
    },
  });

  if (expected.customerAppPaymentsEnabled) {
    if (payReq.status !== 403) {
      ok(`${tenant.code}: customer payment path not capability-blocked (status ${payReq.status})`);
    } else {
      bad(`${tenant.code}: customer payment expected non-blocked, got 403`);
    }
  } else {
    const code = payReq.body?.error?.code;
    if (payReq.status === 403 && code === "CUSTOMER_PAYMENTS_DISABLED") {
      ok(`${tenant.code}: customer payment blocked`);
    } else {
      bad(`${tenant.code}: customer payment expected CUSTOMER_PAYMENTS_DISABLED, got ${payReq.status}/${code ?? "n/a"}`);
    }
  }

  const plansRes = await api("GET", "/app/scheme-plans", { token });
  const plans = dataOf(plansRes)?.data ?? dataOf(plansRes)?.rows ?? [];
  if (!expected.customerSelfEnrol && plans.length) {
    const allBlocked = plans.every((row) => row.canEnrol === false);
    if (allBlocked) ok(`${tenant.code}: plans correctly blocked for self-enrol off`);
    else bad(`${tenant.code}: expected all plan cards canEnrol=false when self-enrol disabled`);
  }
}

async function verifyKairaliCustomerFlows() {
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) {
    bad("KAIRALI tenant not found");
    return;
  }
  const maturedGold = await Scheme.findOne({
    tenantId: tenant._id,
    status: "MATURED",
    valueBasis: "GOLD_WEIGHT",
  }).lean();
  if (!maturedGold) {
    bad("KAIRALI matured gold scheme not found");
  } else {
    const goldCustomer = await Customer.findById(maturedGold.customerId).lean();
    const goldLogin = await customerOtpLogin(tenant.code, goldCustomer.mobile);
    if (!goldLogin.ok) {
      bad(`KAIRALI OTP login for gold customer failed (${goldLogin.status})`);
      return;
    }
    const goldToken = dataOf(goldLogin).accessToken;
    for (const mode of maturedGold.planSnapshot?.redemptionRules?.allowedModes ?? ["CASH"]) {
      const res = await api("GET", `/app/schemes/${maturedGold._id}/settlement-preview`, {
        token: goldToken,
        query: { mode },
      });
      if (res.ok) ok(`KAIRALI settlement-preview gold mode=${mode}`);
      else bad(`KAIRALI settlement-preview gold mode=${mode} failed (${res.status})`);
    }
  }

  const maturedCash = await Scheme.findOne({
    tenantId: tenant._id,
    status: "MATURED",
    valueBasis: "CASH",
  }).lean();
  if (!maturedCash) {
    bad("KAIRALI matured cash scheme not found");
  } else {
    const cashCustomer = await Customer.findById(maturedCash.customerId).lean();
    const cashLogin = await customerOtpLogin(tenant.code, cashCustomer.mobile);
    if (!cashLogin.ok) {
      bad(`KAIRALI OTP login for cash customer failed (${cashLogin.status})`);
      return;
    }
    const cashToken = dataOf(cashLogin).accessToken;
    const mode = maturedCash.planSnapshot?.redemptionRules?.allowedModes?.[0] ?? "CASH";
    const res = await api("GET", `/app/schemes/${maturedCash._id}/settlement-preview`, {
      token: cashToken,
      query: { mode },
    });
    if (res.ok) ok(`KAIRALI settlement-preview cash mode=${mode}`);
    else bad(`KAIRALI settlement-preview cash mode=${mode} failed (${res.status})`);

    const open = await Redemption.findOne({
      tenantId: tenant._id,
      schemeId: maturedCash._id,
      status: { $in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED"] },
    }).lean();
    if (open) {
      ok(`KAIRALI redemption-request create skipped (already open for ${maturedCash.enrollmentNumber})`);
    } else {
      const req = await api("POST", `/app/schemes/${maturedCash._id}/redemption-request`, {
        token: cashToken,
        body: {
          preferredMode: mode,
          preferredDate: "2027-01-01",
          remarks: "Portal action matrix verification",
          expectedVersion: maturedCash.version,
        },
      });
      if (req.ok) ok(`KAIRALI redemption-request created (${maturedCash.enrollmentNumber})`);
      else bad(`KAIRALI redemption-request failed (${req.status})`);
    }
  }
}

async function main() {
  console.log(`Portal action matrix audit @ ${BASE}`);
  await connectDatabase();
  try {
    const opsTenants = await Tenant.find({ code: /^OPS\d{3}$/ }).sort({ code: 1 }).lean();
    if (!opsTenants.length) {
      throw new Error("OPS tenants not found. Run seed:coverage first.");
    }
    console.log(`Checking OPS combinations: ${opsTenants.length} tenants`);
    for (const tenant of opsTenants) {
      const customer = await Customer.findOne({ tenantId: tenant._id }).lean();
      if (!customer) {
        bad(`${tenant.code}: no customer found`);
        continue;
      }
      await verifyOpsTenant(tenant, customer);
    }
    await verifyKairaliCustomerFlows();
  } finally {
    await disconnectDatabase();
  }

  console.log(`\n=== Portal action matrix summary: pass=${pass}, fail=${fail} ===`);
  if (failures.length) {
    console.log("Failures:");
    for (const row of failures) console.log(` - ${row}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

