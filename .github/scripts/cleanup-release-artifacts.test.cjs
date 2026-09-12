const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const cleanupReleaseArtifacts = require('./cleanup-release-artifacts.cjs');

const releaseVersion = '4.1.0';
const finalArtifactId = 9000;
const packageSuffixes = [
  'win-x64',
  'win-x86',
  'win-aarch64',
  'lin-x64-gnu',
  'lin-x64-musl',
  'lin-aarch64-gnu',
  'lin-aarch64-musl',
  'mac-x64',
  'mac-aarch64',
  'win-x64-live-response',
  'win-x86-live-response',
  'win-aarch64-live-response',
  'all-platforms',
];

function artifact(id, name, overrides = {}) {
  return { id, name, expired: false, size_in_bytes: 1024, ...overrides };
}

function releaseArtifacts(version = releaseVersion) {
  return packageSuffixes.map((suffix, index) =>
    artifact(index + 1, `hayabusa-${version}-${suffix}`),
  );
}

function finalArtifact(overrides = {}) {
  return artifact(finalArtifactId, 'all-packages', overrides);
}

function fixture(artifacts, onDelete) {
  const state = {
    artifacts: artifacts.map((item) => ({ ...item })),
    lists: [],
    deletes: [],
    messages: [],
  };
  const context = {
    repo: { owner: 'Yamato-Security', repo: 'hayabusa' },
    runId: 34681732713,
  };
  const listWorkflowRunArtifacts = () => {
    throw new Error('The current-run artifact endpoint must be paginated.');
  };
  const github = {
    rest: {
      actions: {
        listWorkflowRunArtifacts,
        async deleteArtifact(parameters) {
          assert.deepEqual(Object.keys(parameters).sort(), [
            'artifact_id',
            'owner',
            'repo',
          ]);
          assert.equal(parameters.owner, context.repo.owner);
          assert.equal(parameters.repo, context.repo.repo);
          state.deletes.push(parameters.artifact_id);
          if (onDelete) {
            await onDelete(parameters.artifact_id, state);
          }
          state.artifacts = state.artifacts.filter(
            (item) => item.id !== parameters.artifact_id,
          );
          return { status: 204 };
        },
      },
    },
    async paginate(endpoint, parameters) {
      assert.equal(endpoint, listWorkflowRunArtifacts);
      assert.deepEqual(parameters, {
        ...context.repo,
        run_id: context.runId,
        per_page: 100,
      });
      state.lists.push(parameters);
      return state.artifacts.map((item) => ({ ...item }));
    },
  };
  const core = { info: (message) => state.messages.push(message) };

  return {
    state,
    run: (overrides = {}) =>
      cleanupReleaseArtifacts({
        github,
        context,
        core,
        finalArtifactId: String(finalArtifactId),
        releaseVersion,
        ...overrides,
      }),
  };
}

test('deletes all 13 intermediate artifacts from the paginated current-run snapshot', async () => {
  const { run, state } = fixture([...releaseArtifacts(), finalArtifact()]);

  const deletedIds = await run();

  assert.deepEqual(deletedIds, releaseArtifacts().map((item) => item.id));
  assert.deepEqual(state.deletes, deletedIds);
  assert.equal(state.lists.length, 1);
  assert.deepEqual(state.artifacts, [finalArtifact()]);
  assert.ok(state.messages.length > 0);
});

test('preserves unrelated names, other versions, and unknown current-release suffixes', async () => {
  const preserved = [
    finalArtifact(),
    artifact(9001, 'debug-logs'),
    artifact(9002, 'hayabusa-4.0.0-win-x64'),
    artifact(9003, 'hayabusa-4.1.0-win-x64-debug'),
    artifact(9004, 'hayabusa-4.1.0-unknown'),
    artifact(9005, 'hayabusa-pro-4.1.0-win-x64'),
    artifact(9006, 'hayabusa-4.1.00-win-x64'),
    artifact(9007, 'hayabusa-4.1.0-all-packages'),
    artifact(9008, 'all-packages-other'),
  ];
  const { run, state } = fixture([...releaseArtifacts(), ...preserved]);

  await run();

  assert.deepEqual(state.artifacts, preserved);
});

test('matches prerelease and build-metadata versions literally', async () => {
  const version = '4.1.0-rc.1+build.2';
  const unrelated = artifact(9001, 'hayabusa-4.1.0-rcX1+build.2-win-x64');
  const { run, state } = fixture([
    ...releaseArtifacts(version),
    finalArtifact(),
    unrelated,
  ]);

  await run({ releaseVersion: version });

  assert.equal(state.deletes.length, 13);
  assert.deepEqual(state.artifacts, [finalArtifact(), unrelated]);
});

test('accepts a numeric final ID and succeeds when cleanup is already complete', async () => {
  const { run, state } = fixture([finalArtifact()]);

  assert.deepEqual(await run({ finalArtifactId }), []);
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(state.artifacts, [finalArtifact()]);
});

for (const [label, final] of [
  ['missing', undefined],
  ['wrong ID', finalArtifact({ id: finalArtifactId + 1 })],
  ['wrong name', finalArtifact({ name: 'all-packages-other' })],
  ['expired', finalArtifact({ expired: true })],
  ['empty', finalArtifact({ size_in_bytes: 0 })],
]) {
  test(`does not delete anything when the final artifact is ${label}`, async () => {
    const artifacts = releaseArtifacts();
    if (final) artifacts.push(final);
    const { run, state } = fixture(artifacts);

    await assert.rejects(run());

    assert.deepEqual(state.deletes, []);
    assert.deepEqual(state.artifacts, artifacts);
  });
}

test('rejects invalid final artifact IDs without deleting artifacts', async (t) => {
  for (const value of [
    undefined,
    null,
    '',
    'abc',
    '9000oops',
    '0',
    '-1',
    '1.5',
    0,
    -1,
    1.5,
    NaN,
    Infinity,
  ]) {
    await t.test(`${typeof value}: ${String(value)}`, async () => {
      const { run, state } = fixture([...releaseArtifacts(), finalArtifact()]);

      await assert.rejects(run({ finalArtifactId: value }));

      assert.deepEqual(state.deletes, []);
    });
  }
});

test('rejects missing or whitespace-padded release versions without deleting artifacts', async (t) => {
  for (const value of [undefined, null, '', ' ', '\t', ' 4.1.0', '4.1.0 ']) {
    await t.test(`${typeof value}: ${JSON.stringify(value)}`, async () => {
      const { run, state } = fixture([...releaseArtifacts(), finalArtifact()]);

      await assert.rejects(run({ releaseVersion: value }));

      assert.deepEqual(state.deletes, []);
    });
  }
});

test('propagates listing failures without deleting anything', async () => {
  const { run, state } = fixture([...releaseArtifacts(), finalArtifact()]);
  const failure = Object.assign(new Error('API unavailable'), { status: 503 });

  await assert.rejects(
    run({
      github: {
        rest: { actions: { listWorkflowRunArtifacts() {} } },
        async paginate() {
          throw failure;
        },
      },
    }),
    (error) => error === failure,
  );

  assert.deepEqual(state.deletes, []);
});

test('tolerates a deletion 404 when an intermediate artifact was already removed', async () => {
  const { run, state } = fixture(
    [...releaseArtifacts(), finalArtifact()],
    async (id, currentState) => {
      if (id === 1) {
        currentState.artifacts = currentState.artifacts.filter(
          (item) => item.id !== id,
        );
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
    },
  );

  assert.deepEqual(await run(), releaseArtifacts().map((item) => item.id));
  assert.deepEqual(state.artifacts, [finalArtifact()]);
});

test('a retry after partial failure deletes only the remaining intermediates', async () => {
  const failure = Object.assign(new Error('Forbidden'), { status: 403 });
  let failOnce = true;
  const { run, state } = fixture(
    [...releaseArtifacts(), finalArtifact()],
    async (id) => {
      if (id === 2 && failOnce) {
        failOnce = false;
        throw failure;
      }
    },
  );

  await assert.rejects(run(), (error) => error === failure);
  assert.deepEqual(state.deletes, [1, 2]);
  assert.ok(state.artifacts.some((item) => item.id === finalArtifactId));
  assert.equal(state.artifacts.some((item) => item.id === 1), false);
  assert.equal(state.artifacts.some((item) => item.id === 2), true);

  assert.deepEqual(
    await run(),
    releaseArtifacts().slice(1).map((item) => item.id),
  );
  assert.equal(state.lists.length, 2);
  assert.deepEqual(state.artifacts, [finalArtifact()]);
  assert.deepEqual(await run(), []);
  assert.equal(state.deletes.filter((id) => id === 1).length, 1);
});

test('the cleanup allowlist covers exactly the package names emitted by the release workflow', async () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../workflows/release.yml'),
    'utf8',
  );
  const emittedNames = new Set(
    [...workflow.matchAll(/artifact_name=(hayabusa-\$\{\{ github\.event\.inputs\.release_ver \}\}-[^"\r\n]+)/g)]
      .map((match) => match[1].replace('${{ github.event.inputs.release_ver }}', releaseVersion)),
  );
  const aggregateName = workflow.match(
    /name: (hayabusa-\$\{\{ github\.event\.inputs\.release_ver \}\}-all-platforms)\s/,
  );
  assert.ok(aggregateName, 'The all-platforms intermediate upload must be accounted for.');
  emittedNames.add(
    aggregateName[1].replace('${{ github.event.inputs.release_ver }}', releaseVersion),
  );

  assert.deepEqual(
    [...emittedNames].sort(),
    releaseArtifacts().map((item) => item.name).sort(),
  );
  const { run, state } = fixture([
    ...[...emittedNames].map((name, index) => artifact(index + 1, name)),
    finalArtifact(),
  ]);

  assert.equal((await run()).length, emittedNames.size);
  assert.deepEqual(state.artifacts, [finalArtifact()]);
});
