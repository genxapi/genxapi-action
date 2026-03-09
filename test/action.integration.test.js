const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const actionEntrypoint = path.join(repoRoot, 'dist', 'index.js');

test('runs the CLI with normalized inputs, forwards logs, and writes workflow outputs', () => {
  const harness = createHarness({ scenario: 'success' });
  const projectDir = seedProject(harness);

  const result = runAction(harness, {
    INPUT_WORKING_DIRECTORY: 'project',
    INPUT_CONFIG_PATH: 'genxapi.config.json',
    INPUT_CONTRACT_PATH: './contracts/openapi.yaml',
    INPUT_OUTPUT_PATH: './generated/sdk',
    INPUT_PUBLISH_MODE: 'npm',
    INPUT_NPM_TOKEN: 'npm_test_token',
    INPUT_EXTRA_ARGS: JSON.stringify(['--template', 'typescript']),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stub cli log/);

  const outputs = parseEnvFile(harness.outputFile);
  const summary = fs.readFileSync(harness.summaryFile, 'utf8');
  const invocation = readInvocation(harness.recordFile);
  const realProjectDir = realpath(projectDir);

  assert.equal(outputs.summary, 'Stub CLI completed successfully.');
  assert.equal(outputs['working-directory'], projectDir);
  assert.equal(outputs['manifest-path'], path.join(projectDir, 'artifacts', 'manifest.json'));
  assert.equal(outputs['release-manifest-path'], path.join(projectDir, 'artifacts', 'release-manifest.json'));
  assert.match(outputs.command, /^npx -y @genxapi\/cli@latest generate /);
  assert.match(outputs.command, /\[EXTRA_ARG\]/);

  assert.deepEqual(invocation.args, [
    '-y',
    '@genxapi/cli@latest',
    'generate',
    '--config-path',
    path.join(projectDir, 'genxapi.config.json'),
    '--contract-path',
    path.join(projectDir, 'contracts', 'openapi.yaml'),
    '--output-path',
    path.join(projectDir, 'generated', 'sdk'),
    '--publish-mode',
    'npm',
    '--template',
    'typescript',
  ]);
  assert.equal(invocation.cwd, realProjectDir);
  assert.equal(invocation.env.NPM_TOKEN, 'npm_test_token');
  assert.equal(invocation.env.NODE_AUTH_TOKEN, 'npm_test_token');

  assert.match(summary, /Command intent: Run `@genxapi\/cli@latest generate`/);
  assert.match(summary, new RegExp(escapeRegExp(path.join(projectDir, 'generated', 'sdk'))));
  assert.match(summary, /Manifest path:/);
});

test('passes through custom publish modes so the CLI remains the source of truth', () => {
  const harness = createHarness({ scenario: 'success' });
  const projectDir = seedProject(harness);

  const result = runAction(harness, {
    INPUT_WORKING_DIRECTORY: 'project',
    INPUT_CONFIG_PATH: 'genxapi.config.json',
    INPUT_PUBLISH_MODE: 'pnpm',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /::warning::publish-mode "pnpm" is being passed through to the GenX API CLI/
  );

  const invocation = readInvocation(harness.recordFile);
  assert.equal(invocation.cwd, realpath(projectDir));
  assert.deepEqual(invocation.args.slice(0, 7), [
    '-y',
    '@genxapi/cli@latest',
    'generate',
    '--config-path',
    path.join(projectDir, 'genxapi.config.json'),
    '--publish-mode',
    'pnpm',
  ]);
});

test('fails fast for invalid dry-run values and still writes action failure outputs', () => {
  const harness = createHarness({ scenario: 'success' });

  const result = runAction(harness, {
    INPUT_DRY_RUN: 'maybe',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Invalid boolean input for dry-run: maybe/);
  assert.equal(fs.existsSync(harness.recordFile), false);

  const outputs = parseEnvFile(harness.outputFile);
  const summary = fs.readFileSync(harness.summaryFile, 'utf8');

  assert.match(outputs.summary, /Invalid boolean input for dry-run: maybe/);
  assert.equal(outputs.command, 'npx -y @genxapi/cli@latest generate');
  assert.match(summary, /Outcome: failed/);
});

test('fails fast when npm publish mode is missing credentials', () => {
  const harness = createHarness({ scenario: 'success' });
  seedProject(harness);

  const result = runAction(harness, {
    INPUT_WORKING_DIRECTORY: 'project',
    INPUT_CONFIG_PATH: 'genxapi.config.json',
    INPUT_PUBLISH_MODE: 'npm',
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /publish-mode "npm" requires npm-token or an existing NPM_TOKEN\/NODE_AUTH_TOKEN environment variable/
  );
  assert.equal(fs.existsSync(harness.recordFile), false);
});

test('rejects shell-style extra-args so consumer input stays explicit', () => {
  const harness = createHarness({ scenario: 'success' });

  const result = runAction(harness, {
    INPUT_EXTRA_ARGS: '--flag one two',
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /extra-args must be a JSON array string or a newline-delimited list so arguments stay explicit/
  );
  assert.equal(fs.existsSync(harness.recordFile), false);
});

test('fails early when local config-path does not exist', () => {
  const harness = createHarness({ scenario: 'success' });
  seedProject(harness);

  const result = runAction(harness, {
    INPUT_WORKING_DIRECTORY: 'project',
    INPUT_CONFIG_PATH: 'missing.config.json',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /config-path does not exist:/);
  assert.equal(fs.existsSync(harness.recordFile), false);
});

function createHarness({ scenario }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genxapi-action-test-'));
  const workspace = path.join(root, 'workspace');
  const binDir = path.join(root, 'bin');
  const outputFile = path.join(root, 'github-output.txt');
  const summaryFile = path.join(root, 'github-step-summary.md');
  const recordFile = path.join(root, 'npx-invocation.json');

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(outputFile, '');
  fs.writeFileSync(summaryFile, '');

  createNpxStub(binDir);

  return {
    root,
    workspace,
    binDir,
    outputFile,
    summaryFile,
    recordFile,
    scenario,
  };
}

function seedProject(harness) {
  const projectDir = path.join(harness.workspace, 'project');
  const contractsDir = path.join(projectDir, 'contracts');

  fs.mkdirSync(contractsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'genxapi.config.json'), '{\n  "name": "test"\n}\n');
  fs.writeFileSync(path.join(contractsDir, 'openapi.yaml'), 'openapi: 3.0.0\ninfo:\n  title: Test\n');

  return projectDir;
}

function createNpxStub(binDir) {
  const stubScript = path.join(binDir, 'npx-stub.js');
  const shellWrapper = path.join(binDir, 'npx');
  const cmdWrapper = path.join(binDir, 'npx.cmd');
  const escapedNodePath = process.execPath.replace(/\\/g, '\\\\');
  const escapedStubPath = stubScript.replace(/\\/g, '\\\\');

  fs.writeFileSync(
    stubScript,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const recordFile = process.env.GENXAPI_TEST_RECORD;",
      "const scenario = process.env.GENXAPI_TEST_SCENARIO || 'success';",
      'const payload = {',
      '  summary: "Stub CLI completed successfully.",',
      '  manifestPath: "./artifacts/manifest.json",',
      '  releaseManifestPath: "./artifacts/release-manifest.json"',
      '};',
      'const record = {',
      '  args: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  env: {',
      '    NPM_TOKEN: process.env.NPM_TOKEN || "",',
      '    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN || "",',
      '    GITHUB_TOKEN: process.env.GITHUB_TOKEN || ""',
      '  }',
      '};',
      'if (recordFile) {',
      "  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));",
      '}',
      "process.stdout.write('stub cli log\\n');",
      "if (scenario === 'fail') {",
      "  process.stderr.write('stub cli failure\\n');",
      '  process.exit(23);',
      '}',
      'process.stdout.write(JSON.stringify(payload) + "\\n");',
    ].join('\n')
  );

  fs.writeFileSync(
    shellWrapper,
    `#!/bin/sh\nexec "${escapedNodePath}" "${escapedStubPath}" "$@"\n`
  );
  fs.writeFileSync(
    cmdWrapper,
    `@"${escapedNodePath}" "${escapedStubPath}" %*\r\n`
  );

  fs.chmodSync(stubScript, 0o755);
  fs.chmodSync(shellWrapper, 0o755);
}

function runAction(harness, inputs) {
  const env = {
    ...process.env,
    ...inputs,
    GITHUB_OUTPUT: harness.outputFile,
    GITHUB_STEP_SUMMARY: harness.summaryFile,
    GITHUB_WORKSPACE: harness.workspace,
    GENXAPI_TEST_RECORD: harness.recordFile,
    GENXAPI_TEST_SCENARIO: harness.scenario,
    GITHUB_TOKEN: '',
    NPM_TOKEN: '',
    NODE_AUTH_TOKEN: '',
    PATH: `${harness.binDir}${path.delimiter}${process.env.PATH || ''}`,
  };

  return spawnSync(process.execPath, [actionEntrypoint], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function readInvocation(recordFile) {
  return JSON.parse(fs.readFileSync(recordFile, 'utf8'));
}

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  if (!content.trim()) {
    return {};
  }

  const lines = content.split('\n');
  const result = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line) {
      continue;
    }

    const markerIndex = line.indexOf('<<');

    if (markerIndex === -1) {
      continue;
    }

    const name = line.slice(0, markerIndex);
    const delimiter = line.slice(markerIndex + 2);
    const valueLines = [];

    for (index += 1; index < lines.length && lines[index] !== delimiter; index += 1) {
      valueLines.push(lines[index]);
    }

    result[name] = valueLines.join('\n');
  }

  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function realpath(value) {
  return fs.realpathSync(value);
}
