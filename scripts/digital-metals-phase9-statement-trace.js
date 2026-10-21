/**
 * Trace one METAL_STATEMENT artifact through outbox + worker (dev DB).
 * Run: node --env-file=.env scripts/digital-metals-phase9-statement-trace.js [artifactId]
 * With mock storage: PROVIDER_MODE=mock node --env-file=.env scripts/digital-metals-phase9-statement-trace.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  DigitalMetalDocumentArtifact,
  DigitalMetalOutboxEvent,
} from "../src/models/index.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";

async function main() {
  const artifactId = process.argv[2];
  await connectDatabase();
  process.stdout.write(`PROVIDER_MODE=${env.PROVIDER_MODE} PORT=${env.PORT}\n`);

  let artifact;
  if (artifactId) {
    artifact = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
  } else {
    artifact = await DigitalMetalDocumentArtifact.findOne({ docType: "METAL_STATEMENT" })
      .sort({ createdAt: -1 })
      .lean();
  }
  if (!artifact) {
    process.stderr.write("No artifact found\n");
    process.exit(1);
  }

  const outbox = await DigitalMetalOutboxEvent.find({
    tenantId: artifact.tenantId,
    topic: "DIGITAL_METAL_DOCUMENT_ARTIFACT_REQUEST",
    "payload.artifactId": artifact._id,
  })
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();

  process.stdout.write(
    JSON.stringify(
      {
        artifact: {
          id: artifact._id,
          status: artifact.status,
          documentNumber: artifact.documentNumber,
          uploadId: artifact.uploadId,
          lastError: artifact.lastError,
          processingLeaseOwner: artifact.processingLeaseOwner,
          processingAttempts: artifact.processingAttempts,
          availableAt: artifact.availableAt,
        },
        outbox: outbox.map((o) => ({
          id: o._id,
          status: o.status,
          availableAt: o.availableAt,
          lastError: o.lastError,
        })),
      },
      null,
      2,
    ),
  );
  process.stdout.write("\nRunning one outbox dispatch pass…\n");
  const summary = await runDigitalMetalOutboxDispatch();
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  const after = await DigitalMetalDocumentArtifact.findById(artifact._id).lean();
  process.stdout.write(
    JSON.stringify(
      {
        after: {
          status: after.status,
          lastError: after.lastError,
          uploadId: after.uploadId,
          documentNumber: after.documentNumber,
        },
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
  await disconnectDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
