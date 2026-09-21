/**
 * Safety gates for Phase 6 disposable-database verification only.
 */
export function parseMongoTarget(uri) {
  let parsed;
  try {
    parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http://"));
  } catch {
    return null;
  }
  const dbName = parsed.pathname.replace(/^\//, "").split("?")[0] || "";
  return { host: parsed.hostname, dbName };
}

export function assertPhase6DisposableEnvironment({ mongodbUri, nodeEnv = process.env.NODE_ENV }) {
  const target = parseMongoTarget(mongodbUri);
  if (!target) {
    console.error("Cannot parse MONGODB_URI");
    process.exit(1);
  }
  const { host, dbName } = target;
  console.log(`Mongo host: ${host}`);
  console.log(`Database name: ${dbName || "(default)"}`);
  console.log(`NODE_ENV: ${nodeEnv ?? "(unset)"}`);

  const localhost = host === "127.0.0.1" || host === "localhost";
  const disposableName = /phase6_verify|disposable_verify|_verify_/i.test(dbName);
  const safeEnv = nodeEnv === "development" || nodeEnv === "test";

  if (!localhost || !disposableName || !safeEnv) {
    console.error(
      "Abort: require localhost/127.0.0.1, database name containing phase6_verify (or disposable marker), and NODE_ENV development|test.",
    );
    process.exit(1);
  }
  return { host, dbName };
}
