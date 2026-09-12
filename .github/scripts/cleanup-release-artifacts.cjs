// Called only after all-packages has uploaded successfully. Keep this separate from
// packaging so a partially failed cleanup can be retried without its deleted inputs.
module.exports = async function cleanupReleaseArtifacts({
  github, context, core, finalArtifactId, releaseVersion,
}) {
  if (!/^[1-9][0-9]*$/.test(String(finalArtifactId)) ||
      !Number.isSafeInteger(Number(finalArtifactId))) {
    throw new Error('A valid final all-packages artifact ID is required before cleanup.');
  }
  if (typeof releaseVersion !== 'string' || !releaseVersion ||
      releaseVersion.trim() !== releaseVersion) {
    throw new Error('A release version is required before cleanup.');
  }

  // Scope the lookup to this run (including earlier attempts), never the repository.
  // Snapshot all pages before deleting, so deletions cannot shift pagination offsets.
  const artifacts = await github.paginate(
    github.rest.actions.listWorkflowRunArtifacts,
    { ...context.repo, run_id: context.runId, per_page: 100 },
  );
  const finalId = Number(finalArtifactId);
  const bundle = artifacts.find((artifact) => artifact.id === finalId);
  if (!bundle || bundle.name !== 'all-packages' || bundle.expired !== false ||
      !Number.isFinite(bundle.size_in_bytes) || bundle.size_in_bytes <= 0) {
    throw new Error('The final all-packages artifact must exist, be unexpired, and contain data before cleanup.');
  }

  // These are the release.yml uploads already included in all-packages. An exact
  // allowlist protects unrelated artifacts and artifacts belonging to another version.
  const intermediateNames = new Set([
    'win-x64', 'win-x86', 'win-aarch64',
    'lin-x64-gnu', 'lin-x64-musl', 'lin-aarch64-gnu', 'lin-aarch64-musl',
    'mac-x64', 'mac-aarch64',
    'win-x64-live-response', 'win-x86-live-response', 'win-aarch64-live-response',
    'all-platforms',
  ].map((suffix) => `hayabusa-${releaseVersion}-${suffix}`));

  const deletedIds = [];
  for (const artifact of artifacts) {
    if (artifact.id === finalId || !intermediateNames.has(artifact.name)) {
      continue;
    }
    try {
      await github.rest.actions.deleteArtifact({
        ...context.repo, artifact_id: artifact.id,
      });
    } catch (error) {
      // A prior cleanup/manual deletion may already have removed this exact ID.
      // Other failures must fail the job so that cleanup can be retried.
      if (error.status !== 404) {
        throw error;
      }
    }
    deletedIds.push(artifact.id);
    core.info(`Removed intermediate artifact: ${artifact.name} (${artifact.id})`);
  }
  core.info(`Preserved all-packages (${finalId}); cleaned up ${deletedIds.length} intermediate artifacts.`);
  return deletedIds;
};
