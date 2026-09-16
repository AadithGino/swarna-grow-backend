import { Upload } from "../models/index.js";
import { storageProvider } from "../integrations/storage.provider.js";

/** Presigned download URLs for KYC uploads on a customer record. */
export async function buildCustomerKycDocuments(customer) {
  const kyc = customer?.kyc ?? {};
  const documents = [];
  const docDefs = [
    {
      uploadId: kyc.frontUploadId,
      side: "FRONT",
      label: kyc.type === "PAN" ? "PAN card" : "Identity — front",
    },
    { uploadId: kyc.backUploadId, side: "BACK", label: "Identity — back" },
  ];
  for (const def of docDefs) {
    if (!def.uploadId) continue;
    const upload = await Upload.findOne({
      _id: def.uploadId,
      tenantId: customer.tenantId,
    }).lean();
    let viewUrl = null;
    if (upload?.objectKey) {
      viewUrl = await storageProvider.presignDownload(upload.objectKey);
    }
    documents.push({
      side: def.side,
      label: def.label,
      uploadId: def.uploadId,
      fileName: upload?.fileName ?? null,
      viewUrl,
    });
  }
  return documents;
}

/** Merges stored KYC fields with downloadable document metadata. */
export async function enrichCustomerKycRecord(customer, kycDto = null) {
  const kyc = customer?.kyc;
  if (!kyc || kyc.status === "NOT_SUBMITTED") {
    return kycDto ?? kyc ?? null;
  }
  const documents = await buildCustomerKycDocuments(customer);
  const base = kycDto ?? {};
  return {
    ...base,
    status: kyc.status ?? base.status,
    type: kyc.type ?? base.type ?? null,
    number: kyc.number ?? base.number ?? null,
    numberMasked: kyc.numberMasked ?? base.numberMasked ?? null,
    submittedAt: kyc.submittedAt ?? base.submittedAt ?? null,
    verifiedAt: kyc.verifiedAt ?? base.verifiedAt ?? null,
    verifiedBy: kyc.verifiedBy ?? base.verifiedBy ?? null,
    rejectionReason: kyc.rejectionReason ?? base.rejectionReason ?? null,
    documents,
  };
}
