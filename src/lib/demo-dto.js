/**
 * Public Demo Builder payloads use `id` (frontend contract). Mongo lean/docs use `_id`.
 */
export function demoPublicDoc(doc) {
  if (!doc) return doc;
  const plain = typeof doc.toObject === "function" ? doc.toObject({ depopulate: true }) : { ...doc };
  const { _id, __v, linkSecretHash, sealedLinkSecret, ...rest } = plain;
  return { id: String(_id), ...rest };
}

export function demoPublicDocs(docs) {
  return (Array.isArray(docs) ? docs : []).map(demoPublicDoc);
}
