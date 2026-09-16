import { sendSuccess } from "../lib/response.js";
import * as search from "../services/search.service.js";

export const global = async (req, res) => sendSuccess(res, await search.globalSearch(req));
