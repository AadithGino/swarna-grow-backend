# Locked business decisions

These decisions override conflicting examples in the v1.2 contract.

1. Flexible capped-cycle contributions are optional monthly maxima. They never create dues, overdue records, defaults, or automatic due/overdue reminders.
2. Paid money and accrued gold remain permanently in the immutable ledger. At cycle end only unused allowance becomes unavailable; it never carries into a later cycle.
3. An underfunded flexible cycle may affect benefit eligibility only when `requireAllInstallmentsPaid` is enabled. An eligible flexible `ONE_FREE_INSTALLMENT` benefit equals one snapshotted cycle cap.
4. Paying all fixed installments early does not mature the scheme early. It stays active and non-payable until the contractual maturity date.
5. Flexible online payments use `PaymentIntent` in both phases. Free-window intents reserve the submitted amount against configured transaction and scheme limits; capped-phase intents also reserve cycle capacity.
6. Gateway initiation creates a `Payment` with `PENDING`; a verified successful callback converts that same record to `SUCCESS` and then posts the immutable ledger entry.
7. Passbook-image delivery failure switches to the Meta template `PAYMENT_SUCCESS_TEXT_FALLBACK`.
8. Gold benefits use the latest rate effective on or before the maturity date.
9. Export date ranges are capped at five years, with no row cap inside the accepted range.
10. `EXTEND_FLEXIBLE_PHASE` is unsupported and rejected rather than persisted.

Documentation corrections applied by implementation:

- Negative five-thousand rupees is `-₹5,000` (`-500000` paise).
- Flexible capped examples use their actual capped-period dates.
- Fixed-installment coverage wording is not applied to flexible schemes.
- Meta Cloud API credential naming is authoritative.
- Cash acceptance permission is `cash.handover.accept`.
- `/platform/tenants/:tenantId/block` is intentionally absent.
