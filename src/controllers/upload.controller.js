import { sendSuccess } from "../lib/response.js";
import * as uploads from "../services/upload.service.js";

export const complete = async (req, res) =>
  sendSuccess(res, await uploads.completeUpload(req));

export const download = async (req, res) =>
  sendSuccess(res, await uploads.getUploadDownload(req));
