/**
 * Child: one OTP send for multi-process budget tests (AUD-05).
 */
import { connectRedis, disconnectRedis } from "../../src/config/redis.js";
import { otpProvider } from "../../src/integrations/otp.provider.js";

const proc = globalThis.process;
const envConf = JSON.parse(proc.env.OTP_PHASE3_ENV ?? "{}");
const params = JSON.parse(proc.env.OTP_PHASE3_PARAMS ?? "{}");
const ip = proc.env.OTP_PHASE3_IP ?? "198.51.100.10";

await connectRedis();
try {
  await otpProvider.send(params, { env: envConf, request: { ip } });
  proc.exit(0);
} catch (e) {
  globalThis.console.error(String(e?.code ?? e?.message ?? e));
  proc.exit(1);
} finally {
  await disconnectRedis().catch(() => {});
}
