export const sendSuccess = (res, data = {}, meta = {}, status = 200) => res.status(status).json({ success: true, data, ...(Object.keys(meta).length ? { meta } : {}) });
export const sendList = (res, { data, meta }, status = 200) => res.status(status).json({ success: true, data, meta });
