import dayjs from "dayjs";
import { nextSequence } from "../services/sequence.service.js";

/** Counter namespace for platform-wide invoice numbers (not a tenant id). */
export const PLATFORM_SEQUENCE_SCOPE = "__platform__";

/** `PLT/YYYY/0001` — same format as legacy countDocuments-based allocation. */
export async function allocatePlatformInvoiceNumber(session = null) {
  const year = dayjs().format("YYYY");
  const seq = await nextSequence(PLATFORM_SEQUENCE_SCOPE, `invoice:${year}`, session);
  return `PLT/${year}/${String(seq).padStart(4, "0")}`;
}
