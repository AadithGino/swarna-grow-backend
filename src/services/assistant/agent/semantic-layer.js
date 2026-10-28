/**
 * Sidekick semantic layer: the ONLY data the agent's query_data tool can reach.
 *
 * Every entity lists the fields the model may filter, group, sort, select and
 * aggregate on. Anything not listed here (KYC numbers, addresses, bank details,
 * password hashes, tokens, provider payloads…) is unreachable by construction.
 * Tenant and branch scope are injected by the compiler, never by the model.
 */
import {
  Branch,
  CashHandover,
  Customer,
  DigitalMetalBuyOrder,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
  EcommerceOrder,
  EcommerceProduct,
  GoldRate,
  Payment,
  Redemption,
  Scheme,
  SchemePlan,
  User,
} from "../../../models/index.js";
import {
  CashHandoverStatus,
  ClosureType,
  CustomerStatus,
  EcommerceFulfilmentMode,
  EcommerceGoldPurity,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
  EcommerceProductStatus,
  KycStatus,
  PaymentMode,
  PaymentPattern,
  PaymentSource,
  PaymentStatus,
  RedemptionMode,
  RedemptionStatus,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
  UserStatus,
  UserType,
  ValueBasis,
} from "../../../constants/enums.js";
import { NET_COLLECTION_PAYMENT_STATUSES } from "../../../lib/payment-net-aggregation.js";

const vals = (e) => Object.values(e ?? {});

const SOLD_ORDER_STATUSES = [
  EcommerceOrderStatus.PAID,
  EcommerceOrderStatus.PROCESSING,
  EcommerceOrderStatus.READY_FOR_PICKUP,
  EcommerceOrderStatus.SHIPPED,
  EcommerceOrderStatus.DELIVERED,
].filter(Boolean);

const installmentsWithStatus = (statuses) => ({
  $filter: {
    input: { $ifNull: ["$installments", []] },
    as: "i",
    cond: { $in: ["$$i.status", statuses] },
  },
});

/**
 * Field types: id | string | enum | money (paise) | number | count |
 * weight_mg | weight_ug | datetime | ymd (YYYY-MM-DD string) | boolean
 */
export const ENTITIES = Object.freeze({
  payments: {
    model: Payment,
    label: "Payments",
    description:
      "Scheme instalment receipts collected from customers (one row per receipt). Use for 'who paid', 'last UPI payment', payments by mode/staff/branch/plan, and lists of receipts.",
    dateField: "paidAt",
    branchScoped: true,
    defaultWhere: {
      field: "status",
      clause: { status: { $in: NET_COLLECTION_PAYMENT_STATUSES } },
      note: "Only successful receipts (SUCCESS, PARTIALLY_REFUNDED) unless you filter on status yourself.",
    },
    fields: {
      id: { path: "_id", type: "id", label: "Payment id" },
      receiptNumber: { path: "receiptNumber", type: "string", label: "Receipt" },
      amount: { path: "amountPaise", type: "money", label: "Amount" },
      netAmount: {
        type: "money",
        label: "Net amount",
        description: "amount minus refunds",
        expr: {
          $max: [0, { $subtract: ["$amountPaise", { $ifNull: ["$refundedAmountPaise", 0] }] }],
        },
      },
      refundedAmount: { path: "refundedAmountPaise", type: "money", label: "Refunded" },
      goldWeight: { path: "weightMg", type: "weight_mg", label: "Gold credited", description: "grams of gold credited (gold-weight plans)" },
      ratePerGram: { path: "ratePerGramPaise", type: "money", label: "Rate / g" },
      mode: {
        path: "mode",
        type: "enum",
        values: vals(PaymentMode),
        label: "Mode",
        description:
          "UPI = UPI recorded by staff at the counter; ONLINE_GATEWAY = customer paid online in the app; CASH, CARD, BANK_TRANSFER",
      },
      status: { path: "status", type: "enum", values: vals(PaymentStatus), label: "Status" },
      source: { path: "source", type: "enum", values: vals(PaymentSource), label: "Source", description: "PORTAL / STAFF_APP / CUSTOMER_APP / WEBHOOK / SYSTEM" },
      paidAt: { path: "paidAt", type: "datetime", label: "Paid at" },
      installmentCycle: { path: "targetCycle", type: "string", label: "Instalment" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
      schemeId: { path: "schemeId", type: "id", relation: "scheme", label: "Enrolment id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
      collectedById: { path: "collectedBy", type: "id", relation: "collectedBy", label: "Collected by id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
      scheme: { entity: "schemes", localField: "schemeId", fields: ["enrollmentNumber", "planName", "status"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name", "code"] },
      collectedBy: { entity: "staff", localField: "collectedBy", fields: ["name", "role"] },
    },
    defaultSelect: ["paidAt", "receiptNumber", "customer.name", "amount", "mode", "scheme.planName", "branch.name", "collectedBy.name"],
    defaultSort: { by: "paidAt", dir: "desc" },
  },

  customers: {
    model: Customer,
    label: "Customers",
    description: "Customer profiles (scheme members and app users). createdAt = date the customer joined.",
    dateField: "createdAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Customer id" },
      name: { path: "name", type: "string", label: "Name" },
      mobile: { path: "mobile", type: "string", label: "Mobile", personal: "mobile" },
      customerNumber: { path: "customerNumber", type: "string", label: "Customer no." },
      passbookNumber: { path: "passbookNumber", type: "string", label: "Passbook no." },
      status: { path: "status", type: "enum", values: vals(CustomerStatus), label: "Status" },
      kycStatus: { path: "kyc.status", type: "enum", values: vals(KycStatus), label: "KYC" },
      appActivated: {
        type: "boolean",
        label: "App password set",
        description: "true if the customer has set their app password",
        expr: { $cond: [{ $ifNull: ["$passwordSetAt", false] }, true, false] },
      },
      createdAt: { path: "createdAt", type: "datetime", label: "Joined" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      branch: { entity: "branches", localField: "branchId", fields: ["name", "code"] },
    },
    defaultSelect: ["customerNumber", "name", "mobile", "status", "kycStatus", "branch.name", "createdAt"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  schemes: {
    model: Scheme,
    label: "Scheme enrolments",
    description:
      "A customer's enrolment in a savings plan (gold scheme / chitti / kuri). createdAt = enrolled on; startDate/maturityDate are YYYY-MM-DD.",
    dateField: "createdAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Enrolment id" },
      enrollmentNumber: { path: "enrollmentNumber", type: "string", label: "Enrolment no." },
      planName: { path: "planSnapshot.name", type: "string", label: "Plan" },
      status: { path: "status", type: "enum", values: vals(SchemeStatus), label: "Status" },
      paymentPattern: { path: "paymentPattern", type: "enum", values: vals(PaymentPattern), label: "Pattern", description: "FIXED monthly instalments or FLEXIBLE amounts" },
      valueBasis: { path: "valueBasis", type: "enum", values: vals(ValueBasis), label: "Value basis", description: "CASH value or GOLD_WEIGHT accumulation" },
      startDate: { path: "startDate", type: "ymd", label: "Start date" },
      maturityDate: { path: "maturityDate", type: "ymd", label: "Maturity date" },
      installmentAmount: { path: "installmentAmountPaise", type: "money", label: "Instalment" },
      totalInstallments: { type: "count", label: "Instalments", expr: { $size: { $ifNull: ["$installments", []] } } },
      paidInstallments: { type: "count", label: "Paid instalments", expr: { $size: installmentsWithStatus(["PAID"]) } },
      overdueInstallments: { type: "count", label: "Overdue instalments", expr: { $size: installmentsWithStatus(["OVERDUE"]) } },
      overdueAmount: {
        type: "money",
        label: "Overdue amount",
        expr: {
          $sum: {
            $map: {
              input: installmentsWithStatus(["OVERDUE"]),
              as: "i",
              in: { $max: [0, { $subtract: [{ $ifNull: ["$$i.amountPaise", 0] }, { $ifNull: ["$$i.paidPaise", 0] }] }] },
            },
          },
        },
      },
      closedAt: { path: "closedAt", type: "datetime", label: "Closed at" },
      closureReason: { path: "closureReason", type: "string", label: "Closure reason" },
      createdAt: { path: "createdAt", type: "datetime", label: "Enrolled on" },
      planId: { path: "planId", type: "id", relation: "plan", label: "Plan id" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name", "code"] },
      plan: { entity: "plans", localField: "planId", fields: ["name", "code"] },
    },
    defaultSelect: ["enrollmentNumber", "customer.name", "planName", "status", "startDate", "maturityDate", "paidInstallments", "overdueInstallments"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  plans: {
    model: SchemePlan,
    label: "Scheme plans",
    description: "Savings plan templates the jeweller offers (e.g. Gold 360, 11-month plan).",
    dateField: "createdAt",
    branchScoped: false,
    branchFree: true,
    fields: {
      id: { path: "_id", type: "id", label: "Plan id" },
      name: { path: "name", type: "string", label: "Plan" },
      code: { path: "code", type: "string", label: "Code" },
      status: { path: "status", type: "enum", values: vals(SchemePlanStatus), label: "Status" },
      paymentPattern: { path: "paymentPattern", type: "enum", values: vals(PaymentPattern), label: "Pattern" },
      valueBasis: { path: "valueBasis", type: "enum", values: vals(ValueBasis), label: "Value basis" },
      durationMonths: { path: "durationMonths", type: "number", label: "Months" },
      installmentCount: { path: "installmentCount", type: "number", label: "Instalments" },
      createdAt: { path: "createdAt", type: "datetime", label: "Created" },
    },
    relations: {},
    defaultSelect: ["name", "code", "status", "paymentPattern", "valueBasis", "durationMonths"],
    defaultSort: { by: "name", dir: "asc" },
  },

  redemptions: {
    model: Redemption,
    label: "Redemptions",
    description: "Scheme maturity redemptions and premature closures (cash payout, gold handover or purchase adjustment).",
    dateField: "createdAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Redemption id" },
      status: { path: "status", type: "enum", values: vals(RedemptionStatus), label: "Status" },
      mode: { path: "mode", type: "enum", values: vals(RedemptionMode), label: "Mode" },
      closureType: { path: "closureType", type: "enum", values: vals(ClosureType), label: "Type" },
      principal: { path: "principalPaise", type: "money", label: "Principal" },
      benefit: { path: "benefitPaise", type: "money", label: "Benefit / bonus" },
      settlement: { path: "settlementPaise", type: "money", label: "Settlement value" },
      cashOut: { path: "cashOutPaise", type: "money", label: "Cash paid out" },
      goldWeight: { path: "weightMg", type: "weight_mg", label: "Gold weight" },
      requestedAt: { path: "requestedAt", type: "datetime", label: "Requested" },
      completedAt: { path: "completedAt", type: "datetime", label: "Completed" },
      createdAt: { path: "createdAt", type: "datetime", label: "Created" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
      schemeId: { path: "schemeId", type: "id", relation: "scheme", label: "Enrolment id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
      scheme: { entity: "schemes", localField: "schemeId", fields: ["enrollmentNumber", "planName"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name", "code"] },
    },
    defaultSelect: ["createdAt", "customer.name", "scheme.planName", "closureType", "mode", "status", "settlement"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  branches: {
    model: Branch,
    label: "Branches",
    description: "Showrooms / branches of the jeweller.",
    dateField: "createdAt",
    branchScoped: true,
    branchIdField: "_id",
    fields: {
      id: { path: "_id", type: "id", label: "Branch id" },
      name: { path: "name", type: "string", label: "Branch" },
      code: { path: "code", type: "string", label: "Code" },
      active: { path: "active", type: "boolean", label: "Active" },
      isHeadOffice: { path: "isHeadOffice", type: "boolean", label: "Head office" },
      createdAt: { path: "createdAt", type: "datetime", label: "Created" },
    },
    relations: {},
    defaultSelect: ["name", "code", "active", "isHeadOffice"],
    defaultSort: { by: "name", dir: "asc" },
  },

  staff: {
    model: User,
    label: "Staff",
    description: "Staff users of the jeweller (owners, admins, branch managers, staff, collection agents).",
    dateField: "createdAt",
    branchScoped: true,
    baseWhere: { type: UserType.TENANT_USER },
    fields: {
      id: { path: "_id", type: "id", label: "Staff id" },
      name: { path: "name", type: "string", label: "Name" },
      role: { path: "role", type: "enum", values: vals(TenantRole), label: "Role" },
      status: { path: "status", type: "enum", values: vals(UserStatus), label: "Status" },
      lastSeenAt: { path: "lastSeenAt", type: "datetime", label: "Last seen" },
      createdAt: { path: "createdAt", type: "datetime", label: "Added" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      branch: { entity: "branches", localField: "branchId", fields: ["name", "code"] },
    },
    defaultSelect: ["name", "role", "status", "branch.name", "lastSeenAt"],
    defaultSort: { by: "name", dir: "asc" },
  },

  gold_rates: {
    model: GoldRate,
    label: "Gold rates",
    description: "Gold rate (22K per gram) published by the jeweller for schemes; multiple publishes per day are kept.",
    dateField: "effectiveDate",
    branchScoped: true,
    allowNullBranch: true,
    fields: {
      id: { path: "_id", type: "id", label: "Rate id" },
      ratePerGram: { path: "ratePerGramPaise", type: "money", label: "Rate / g" },
      effectiveDate: { path: "effectiveDate", type: "ymd", label: "Date" },
      purity: { path: "purity", type: "enum", values: ["22K"], label: "Purity" },
      createdAt: { path: "createdAt", type: "datetime", label: "Published at" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      branch: { entity: "branches", localField: "branchId", fields: ["name"] },
    },
    defaultSelect: ["effectiveDate", "ratePerGram", "purity", "createdAt"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  digital_gold_buys: {
    model: DigitalMetalBuyOrder,
    label: "Digi Gold purchases",
    description: "Customers buying digital gold/silver in the app. CREDITED = completed purchase.",
    dateField: "createdAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Order id" },
      status: {
        path: "status",
        type: "enum",
        values: ["QUOTE_ACCEPTED", "PAYMENT_PENDING", "PAYMENT_VERIFIED", "CREDITED", "EXPIRED", "PAYMENT_FAILED", "REFUND_REVIEW", "REFUNDED"],
        label: "Status",
      },
      metal: { path: "metal", type: "enum", values: ["GOLD", "SILVER"], label: "Metal" },
      quantity: { path: "quantityUg", type: "weight_ug", label: "Quantity" },
      amount: { path: "totalPayablePaise", type: "money", label: "Amount paid" },
      creditedAt: { path: "creditedAt", type: "datetime", label: "Credited at" },
      createdAt: { path: "createdAt", type: "datetime", label: "Ordered at" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name"] },
    },
    defaultSelect: ["createdAt", "customer.name", "metal", "quantity", "amount", "status"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  digital_gold_sells: {
    model: DigitalMetalSellOrder,
    label: "Digi Gold sell-backs",
    description: "Customers selling digital gold/silver back. EXECUTED/PAYABLE_OPEN = sale done.",
    dateField: "createdAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Order id" },
      status: {
        path: "status",
        type: "enum",
        values: ["RESERVED", "PENDING_APPROVAL", "EXECUTED", "PAYABLE_OPEN", "CANCELLED", "EXPIRED"],
        label: "Status",
      },
      metal: { path: "metal", type: "enum", values: ["GOLD", "SILVER"], label: "Metal" },
      quantity: { path: "quantityUg", type: "weight_ug", label: "Quantity" },
      settlement: { path: "settlementPaise", type: "money", label: "Payout" },
      executedAt: { path: "executedAt", type: "datetime", label: "Executed at" },
      createdAt: { path: "createdAt", type: "datetime", label: "Requested at" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name"] },
    },
    defaultSelect: ["createdAt", "customer.name", "metal", "quantity", "settlement", "status"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  digital_gold_wallets: {
    model: DigitalMetalWallet,
    label: "Digi Gold holdings",
    description: "Each customer's digital gold/silver balance (held quantity).",
    dateField: "updatedAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Wallet id" },
      metal: { path: "metal", type: "enum", values: ["GOLD", "SILVER"], label: "Metal" },
      held: { path: "heldUg", type: "weight_ug", label: "Held" },
      reserved: { path: "reservedUg", type: "weight_ug", label: "Reserved" },
      updatedAt: { path: "updatedAt", type: "datetime", label: "Updated" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name"] },
    },
    defaultSelect: ["customer.name", "metal", "held", "updatedAt"],
    defaultSort: { by: "held", dir: "desc" },
  },

  store_orders: {
    model: EcommerceOrder,
    label: "Online store orders",
    description:
      "Online store (ecommerce) orders. Sales = status PAID, PROCESSING, READY_FOR_PICKUP, SHIPPED, DELIVERED.",
    dateField: "createdAt",
    branchScoped: false,
    fields: {
      id: { path: "_id", type: "id", label: "Order id" },
      orderNumber: { path: "orderNumber", type: "string", label: "Order no." },
      status: { path: "status", type: "enum", values: vals(EcommerceOrderStatus), label: "Status" },
      total: { path: "totalPaise", type: "money", label: "Order total" },
      subtotal: { path: "subtotalPaise", type: "money", label: "Subtotal" },
      tax: { path: "taxPaise", type: "money", label: "Tax" },
      paymentMethod: { path: "paymentMethod", type: "enum", values: vals(EcommercePaymentMethod), label: "Payment" },
      fulfilmentMode: { path: "fulfilmentMode", type: "enum", values: vals(EcommerceFulfilmentMode), label: "Fulfilment" },
      itemCount: { type: "count", label: "Items", expr: { $size: { $ifNull: ["$lines", []] } } },
      paidAt: { path: "paidAt", type: "datetime", label: "Paid at" },
      createdAt: { path: "createdAt", type: "datetime", label: "Ordered at" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "mobile", "customerNumber"] },
    },
    defaultSelect: ["createdAt", "orderNumber", "customer.name", "total", "status", "paymentMethod"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  store_order_items: {
    model: EcommerceOrder,
    label: "Online store order items",
    description:
      "One row per product line in online store orders — use for best-selling products. Only sold orders unless you filter orderStatus yourself.",
    dateField: "createdAt",
    branchScoped: false,
    preStages: [{ $unwind: "$lines" }],
    defaultWhere: {
      field: "orderStatus",
      clause: { status: { $in: SOLD_ORDER_STATUSES } },
      note: "Only sold orders (PAID → DELIVERED) unless you filter orderStatus yourself.",
    },
    fields: {
      productName: { path: "lines.name", type: "string", label: "Product" },
      sku: { path: "lines.sku", type: "string", label: "SKU" },
      productId: { path: "lines.productId", type: "id", label: "Product id" },
      quantity: { path: "lines.quantity", type: "number", label: "Qty" },
      unitPrice: { path: "lines.unitPricePaise", type: "money", label: "Unit price" },
      lineTotal: { path: "lines.lineTotalPaise", type: "money", label: "Line total" },
      orderNumber: { path: "orderNumber", type: "string", label: "Order no." },
      orderStatus: { path: "status", type: "enum", values: vals(EcommerceOrderStatus), label: "Order status" },
      createdAt: { path: "createdAt", type: "datetime", label: "Ordered at" },
      customerId: { path: "customerId", type: "id", relation: "customer", label: "Customer id" },
    },
    relations: {
      customer: { entity: "customers", localField: "customerId", fields: ["name", "customerNumber"] },
    },
    defaultSelect: ["createdAt", "orderNumber", "productName", "quantity", "lineTotal"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  store_products: {
    model: EcommerceProduct,
    label: "Online store products",
    description: "Catalogue products in the online store.",
    dateField: "createdAt",
    branchScoped: false,
    branchFree: true,
    fields: {
      id: { path: "_id", type: "id", label: "Product id" },
      name: { path: "name", type: "string", label: "Product" },
      sku: { path: "sku", type: "string", label: "SKU" },
      status: { path: "status", type: "enum", values: vals(EcommerceProductStatus), label: "Status" },
      purity: { path: "purity", type: "enum", values: vals(EcommerceGoldPurity), label: "Purity" },
      goldWeight: { path: "goldWeightMg", type: "weight_mg", label: "Gold weight" },
      featured: { path: "featured", type: "boolean", label: "Featured" },
      createdAt: { path: "createdAt", type: "datetime", label: "Created" },
    },
    relations: {},
    defaultSelect: ["name", "sku", "status", "purity", "goldWeight", "featured"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },

  cash_handovers: {
    model: CashHandover,
    label: "Cash handovers",
    description: "Cash collected by staff/agents handed over to the branch (pending, accepted, discrepancies).",
    dateField: "createdAt",
    branchScoped: true,
    fields: {
      id: { path: "_id", type: "id", label: "Handover id" },
      status: { path: "status", type: "enum", values: vals(CashHandoverStatus), label: "Status" },
      amount: { path: "amountPaise", type: "money", label: "Amount" },
      acceptedAmount: { path: "acceptedAmountPaise", type: "money", label: "Accepted" },
      discrepancy: { path: "discrepancyPaise", type: "money", label: "Discrepancy" },
      submittedAt: { path: "submittedAt", type: "datetime", label: "Submitted" },
      settledAt: { path: "settledAt", type: "datetime", label: "Settled" },
      createdAt: { path: "createdAt", type: "datetime", label: "Created" },
      staffId: { path: "staffId", type: "id", relation: "staff", label: "Staff id" },
      branchId: { path: "branchId", type: "id", relation: "branch", label: "Branch id" },
    },
    relations: {
      staff: { entity: "staff", localField: "staffId", fields: ["name", "role"] },
      branch: { entity: "branches", localField: "branchId", fields: ["name"] },
    },
    defaultSelect: ["createdAt", "staff.name", "amount", "status", "acceptedAmount", "discrepancy"],
    defaultSort: { by: "createdAt", dir: "desc" },
  },
});

export const ENTITY_NAMES = Object.freeze(Object.keys(ENTITIES));

export function entityDef(name) {
  return ENTITIES[name] ?? null;
}

/**
 * Resolve "amount" or "customer.name" on an entity.
 * Returns { kind: "direct"|"related", def, path, relationName?, relation?, targetEntity? }.
 */
export function resolveField(entityName, ref) {
  const entity = ENTITIES[entityName];
  if (!entity || typeof ref !== "string" || !ref) return null;
  if (entity.fields[ref]) {
    return { kind: "direct", key: ref, def: entity.fields[ref] };
  }
  const dot = ref.indexOf(".");
  if (dot > 0) {
    const relationName = ref.slice(0, dot);
    const targetField = ref.slice(dot + 1);
    const relation = entity.relations?.[relationName];
    if (!relation || !relation.fields.includes(targetField)) return null;
    const target = ENTITIES[relation.entity];
    const def = target?.fields?.[targetField];
    if (!def) return null;
    return {
      kind: "related",
      key: ref,
      def,
      relationName,
      relation,
      targetEntity: relation.entity,
      targetField,
    };
  }
  // Bare relation name ("customer") → its label field
  const relation = entity.relations?.[ref];
  if (relation) {
    const targetField = relation.fields[0];
    const def = ENTITIES[relation.entity].fields[targetField];
    return {
      kind: "related",
      key: `${ref}.${targetField}`,
      def,
      relationName: ref,
      relation,
      targetEntity: relation.entity,
      targetField,
    };
  }
  return null;
}

export function fieldRefsFor(entityName) {
  const entity = ENTITIES[entityName];
  if (!entity) return [];
  const refs = Object.keys(entity.fields);
  for (const [relName, rel] of Object.entries(entity.relations ?? {})) {
    for (const f of rel.fields) refs.push(`${relName}.${f}`);
  }
  return refs;
}

/** Compact, model-facing description of the semantic layer (goes into the static system prompt). */
export function semanticLayerForPrompt() {
  const lines = [];
  for (const [name, e] of Object.entries(ENTITIES)) {
    lines.push(`### ${name} — ${e.description}`);
    lines.push(`date field: ${e.dateField}${e.defaultWhere ? ` · default: ${e.defaultWhere.note}` : ""}`);
    const fieldBits = [];
    for (const [key, f] of Object.entries(e.fields)) {
      let bit = `${key}:${f.type}`;
      if (f.values?.length) bit += `(${f.values.join("|")})`;
      if (f.description) bit += ` — ${f.description}`;
      fieldBits.push(bit);
    }
    lines.push(`fields: ${fieldBits.join("; ")}`);
    const rels = Object.entries(e.relations ?? {}).map(
      ([rel, r]) => `${rel}.{${r.fields.join(",")}}`,
    );
    if (rels.length) lines.push(`related: ${rels.join(" ")}`);
  }
  return lines.join("\n");
}
