/** Test-only: block document artifact processing after lease claim (simulates worker stall). */
export const digitalMetalDocumentArtifactTestHooks = {
  holdAfterClaimForArtifactId: null,
  /** Resolved when test releases the simulated worker. */
  holdAfterClaimGate: Promise.resolve(),
  releaseHold: null,
};

export function armDocumentArtifactHoldAfterClaim(artifactId) {
  digitalMetalDocumentArtifactTestHooks.holdAfterClaimForArtifactId = artifactId;
  digitalMetalDocumentArtifactTestHooks.holdAfterClaimGate = new Promise((resolve) => {
    digitalMetalDocumentArtifactTestHooks.releaseHold = resolve;
  });
}

export function clearDocumentArtifactTestHooksForTests() {
  digitalMetalDocumentArtifactTestHooks.holdAfterClaimForArtifactId = null;
  digitalMetalDocumentArtifactTestHooks.holdAfterClaimGate = Promise.resolve();
  digitalMetalDocumentArtifactTestHooks.releaseHold = null;
}
