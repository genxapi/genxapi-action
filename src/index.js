const core = require('@actions/core');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI_PACKAGE_NAME = 'genxapi';
const CLI_COMMAND = 'genxapi';
const DEFAULT_GENXAPI_VERSION = '0.1.0';
const VALID_PUBLISH_MODES = new Set(['none', 'npm', 'github-packages']);

async function run() {
  try {
    const inputs = getInputs();
    validateInputs(inputs);

    const cwd = resolveWorkingDirectory(inputs.workingDirectory);
    const extraArgs = parseExtraArgs(inputs.extraArgsRaw);
    const cliArgs = buildCliArgs(inputs, extraArgs);
    const env = buildCliEnvironment(inputs);

    logExecutionPlan(inputs, cwd, extraArgs.length);

    const result = await executeCli({
      command: getNpxCommand(),
      args: cliArgs,
      cwd,
      env,
    });

    if (result.exitCode !== 0) {
      throw new Error(formatCliFailure(result));
    }

    const payload = extractCliPayload(result.stdout);
    const outputs = buildOutputs({ inputs, cwd, payload, stdout: result.stdout });

    setOutputs(outputs);

    core.info(outputs.summary);
  } catch (error) {
    core.setFailed(formatError(error));
  }
}

function getInputs() {
  return {
    genxapiVersion: core.getInput('genxapi-version').trim() || DEFAULT_GENXAPI_VERSION,
    configPath: core.getInput('config-path').trim(),
    contractPath: core.getInput('contract-path').trim(),
    outputPath: core.getInput('output-path').trim(),
    publishMode: (core.getInput('publish-mode').trim() || 'none').toLowerCase(),
    dryRun: core.getBooleanInput('dry-run'),
    workingDirectory: core.getInput('working-directory').trim() || '.',
    extraArgsRaw: core.getInput('extra-args'),
    npmToken: core.getInput('npm-token'),
    githubToken: core.getInput('github-token'),
  };
}

function validateInputs(inputs) {
  if (!VALID_PUBLISH_MODES.has(inputs.publishMode)) {
    throw new Error(
      `Unsupported publish-mode "${inputs.publishMode}". Supported values: ${Array.from(VALID_PUBLISH_MODES).join(', ')}.`
    );
  }

  if (inputs.publishMode === 'npm' && !inputs.npmToken.trim()) {
    core.warning('publish-mode is npm but npm-token was not provided. The GenX API CLI will rely on existing npm auth state.');
  }

  if (inputs.publishMode === 'github-packages' && !inputs.githubToken.trim()) {
    core.warning(
      'publish-mode is github-packages but github-token was not provided. The GenX API CLI will rely on existing GitHub auth state.'
    );
  }

  if (inputs.genxapiVersion === 'latest') {
    core.warning('genxapi-version is set to latest. This action is designed to work best with explicit CLI versions.');
  }
}

function resolveWorkingDirectory(inputPath) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const cwd = path.resolve(workspace, inputPath);

  if (!fs.existsSync(cwd)) {
    throw new Error(`working-directory does not exist: ${cwd}`);
  }

  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error(`working-directory is not a directory: ${cwd}`);
  }

  return cwd;
}

function parseExtraArgs(rawValue) {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    let parsed;

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`extra-args must be valid JSON when using array syntax. ${formatError(error)}`);
    }

    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('extra-args JSON form must be an array of strings.');
    }

    return parsed;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 1 && /\s/.test(lines[0])) {
    throw new Error('extra-args must be a JSON array or a newline-delimited list so arguments can be passed safely without shell parsing.');
  }

  return lines;
}

function buildCliArgs(inputs, extraArgs) {
  const args = [
    '--yes',
    '--package',
    `${CLI_PACKAGE_NAME}@${inputs.genxapiVersion}`,
    '--',
    CLI_COMMAND,
    'generate',
    '--json',
    '--publish-mode',
    inputs.publishMode,
  ];

  pushFlag(args, '--config', inputs.configPath);
  pushFlag(args, '--contract', inputs.contractPath);
  pushFlag(args, '--output', inputs.outputPath);

  if (inputs.dryRun) {
    args.push('--dry-run');
  }

  args.push(...extraArgs);

  return args;
}

function pushFlag(args, flag, value) {
  if (!value) {
    return;
  }

  args.push(flag, value);
}

function buildCliEnvironment(inputs) {
  const env = { ...process.env };

  if (inputs.npmToken.trim()) {
    core.setSecret(inputs.npmToken);
    env.NPM_TOKEN = inputs.npmToken;
    env.NODE_AUTH_TOKEN = inputs.npmToken;
  }

  if (inputs.githubToken.trim()) {
    core.setSecret(inputs.githubToken);
    env.GITHUB_TOKEN = inputs.githubToken;
  }

  return env;
}

function logExecutionPlan(inputs, cwd, extraArgCount) {
  core.info(`GenX API action working directory: ${cwd}`);
  core.info(`GenX API CLI version: ${inputs.genxapiVersion}`);
  core.info(`Publish mode: ${inputs.publishMode}`);
  core.info(`Dry run: ${inputs.dryRun ? 'enabled' : 'disabled'}`);
  core.info(`Config path provided: ${inputs.configPath ? 'yes' : 'no'}`);
  core.info(`Contract path provided: ${inputs.contractPath ? 'yes' : 'no'}`);
  core.info(`Output path provided: ${inputs.outputPath ? 'yes' : 'no'}`);
  core.info(`Extra CLI args: ${extraArgCount}`);
}

function executeCli({ command, args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start the GenX API CLI via npx. ${formatError(error)}`));
    });

    child.on('close', (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function extractCliPayload(stdout) {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return {};
  }

  const direct = tryParseJson(trimmed);

  if (direct && typeof direct === 'object') {
    return direct;
  }

  const lastLine = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();

  if (lastLine) {
    const lastLinePayload = tryParseJson(lastLine);

    if (lastLinePayload && typeof lastLinePayload === 'object') {
      return lastLinePayload;
    }
  }

  return {};
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildOutputs({ inputs, cwd, payload, stdout }) {
  const payloadRoots = [payload, payload.outputs, payload.result, payload.data].filter(isObject);
  const fallbackSummary = `GenX API CLI completed successfully with publish-mode=${inputs.publishMode}${inputs.dryRun ? ' (dry-run)' : ''}.`;

  return {
    resolvedContractSource: normalizeContractSource(findPayloadValue(payloadRoots, [
      'resolvedContractSource',
      'resolved_contract_source',
      'resolved-contract-source',
      'contractSource',
      'contract_source',
    ]), cwd),
    template: findPayloadValue(payloadRoots, ['template']),
    outputPath: normalizePathValue(
      findPayloadValue(payloadRoots, ['outputPath', 'output_path', 'output-path']) || inputs.outputPath,
      cwd
    ),
    manifestPath: normalizePathValue(findPayloadValue(payloadRoots, ['manifestPath', 'manifest_path', 'manifest-path']), cwd),
    publishedPackageName: findPayloadValue(payloadRoots, [
      'publishedPackageName',
      'published_package_name',
      'published-package-name',
      'packageName',
      'package_name',
    ]),
    publishedPackageVersion: findPayloadValue(payloadRoots, [
      'publishedPackageVersion',
      'published_package_version',
      'published-package-version',
      'packageVersion',
      'package_version',
    ]),
    releaseManifestPath: normalizePathValue(
      findPayloadValue(payloadRoots, ['releaseManifestPath', 'release_manifest_path', 'release-manifest-path']),
      cwd
    ),
    summary:
      stringifyValue(findPayloadValue(payloadRoots, ['summary', 'message'])) ||
      buildStdoutSummary(stdout) ||
      fallbackSummary,
  };
}

function findPayloadValue(roots, keys) {
  for (const root of roots) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(root, key) && root[key] !== undefined && root[key] !== null && root[key] !== '') {
        return root[key];
      }
    }
  }

  return '';
}

function normalizePathValue(value, cwd) {
  const stringValue = stringifyValue(value);

  if (!stringValue) {
    return '';
  }

  if (isUrl(stringValue) || path.isAbsolute(stringValue)) {
    return stringValue;
  }

  return path.resolve(cwd, stringValue);
}

function normalizeContractSource(value, cwd) {
  return normalizePathValue(value, cwd);
}

function buildStdoutSummary(stdout) {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return '';
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  return lines.slice(-5).join('\n');
}

function stringifyValue(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function setOutputs(outputs) {
  setOutput('resolved-contract-source', outputs.resolvedContractSource);
  setOutput('template', outputs.template);
  setOutput('output-path', outputs.outputPath);
  setOutput('manifest-path', outputs.manifestPath);
  setOutput('published-package-name', outputs.publishedPackageName);
  setOutput('published-package-version', outputs.publishedPackageVersion);
  setOutput('release-manifest-path', outputs.releaseManifestPath);
  setOutput('summary', outputs.summary);
}

function setOutput(name, value) {
  if (!value) {
    return;
  }

  core.setOutput(name, value);
}

function formatCliFailure(result) {
  const exitLabel = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').trim();
  const tail = detail ? detail.split(/\r?\n/).slice(-20).join('\n') : 'The CLI did not provide additional output.';

  return `GenX API CLI failed with ${exitLabel}. Check config-path, contract-path, publish-mode, and extra-args.\n${tail}`;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

run();
