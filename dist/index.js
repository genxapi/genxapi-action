'use strict';

const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, statSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const CLI_PACKAGE = '@genxapi/cli@latest';
const COMMAND_INTENT = `Run \`${CLI_PACKAGE} generate\``;
const TRUE_BOOLEAN_INPUTS = ['true', '1', 'yes', 'y', 'on'];
const FALSE_BOOLEAN_INPUTS = ['false', '0', 'no', 'n', 'off'];
const MAX_CAPTURE_CHARS = 256 * 1024;

void main();

async function main() {
  let inputs = createDefaultInputs();
  let options = null;
  let commandOutput = `npx -y ${CLI_PACKAGE} generate`;

  try {
    inputs = readInputs();

    const tokens = resolveTokens(inputs);
    maskTokens(tokens);

    options = normalizeOptions(inputs, tokens);
    commandOutput = formatCommand(getNpxCommand(), options.cliArgs, options.extraArgs.length);

    setOutputs({
      command: commandOutput,
      'working-directory': options.workingDirectory,
    });

    logStart(options, commandOutput);

    const result = await runCommand(
      getNpxCommand(),
      options.cliArgs,
      options.workingDirectory,
      buildEnvironment(tokens)
    );

    if (result.exitCode !== 0) {
      const summary = buildFailureMessage(result, commandOutput, options);

      setOutputs({ summary });
      writeStepSummary(
        buildStepSummary({
          outcome: 'failed',
          command: commandOutput,
          workingDirectory: options.workingDirectory,
          publishMode: options.publishMode,
          dryRun: options.dryRun,
          outputPath: options.outputPath,
          summary,
        })
      );
      fail(summary);
      return;
    }

    const discovered = extractKnownOutputs(result.stdout, result.stderr, options.workingDirectory);
    const summary = discovered.summary || buildSuccessSummary(options);

    setOutputs({
      summary,
      'manifest-path': discovered.manifestPath,
      'release-manifest-path': discovered.releaseManifestPath,
    });

    writeStepSummary(
      buildStepSummary({
        outcome: 'succeeded',
        command: commandOutput,
        workingDirectory: options.workingDirectory,
        publishMode: options.publishMode,
        dryRun: options.dryRun,
        outputPath: options.outputPath,
        manifestPath: discovered.manifestPath,
        releaseManifestPath: discovered.releaseManifestPath,
        summary,
      })
    );

    log(summary);
  } catch (error) {
    const summary = `GenX API action failed. ${formatError(error)}`;

    setOutputs({
      command: commandOutput,
      summary,
      'working-directory': options?.workingDirectory,
    });

    writeStepSummary(
      buildStepSummary({
        outcome: 'failed',
        command: commandOutput,
        workingDirectory: options?.workingDirectory || 'unresolved',
        publishMode: options?.publishMode || 'none',
        dryRun: options?.dryRun || false,
        outputPath: options?.outputPath,
        summary,
      })
    );
    fail(summary);
  }
}

function createDefaultInputs() {
  return {
    configPath: '',
    contractPath: '',
    outputPath: '',
    publishMode: 'none',
    dryRun: 'false',
    workingDirectory: '.',
    extraArgs: '',
    npmToken: '',
    githubToken: '',
  };
}

function readInputs() {
  return {
    configPath: readInput('config-path'),
    contractPath: readInput('contract-path'),
    outputPath: readInput('output-path'),
    publishMode: readInput('publish-mode', 'none'),
    dryRun: readInput('dry-run', 'false'),
    workingDirectory: readInput('working-directory', '.'),
    extraArgs: readInput('extra-args'),
    npmToken: readInput('npm-token'),
    githubToken: readInput('github-token'),
  };
}

function readInput(name, fallback = '') {
  const variants = new Set([
    `INPUT_${name.replace(/ /g, '_').toUpperCase()}`,
    `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`,
  ]);

  for (const key of variants) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      return String(process.env[key] || '').trim();
    }
  }

  return fallback.trim();
}

function resolveTokens(inputs) {
  return {
    npmToken: inputs.npmToken || process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '',
    githubToken: inputs.githubToken || process.env.GITHUB_TOKEN || '',
  };
}

function maskTokens(tokens) {
  if (tokens.npmToken) {
    addMask(tokens.npmToken);
  }

  if (tokens.githubToken) {
    addMask(tokens.githubToken);
  }
}

function normalizeOptions(inputs, tokens) {
  const publishMode = parsePublishMode(inputs.publishMode);
  const dryRun = parseBooleanInput('dry-run', inputs.dryRun, false);
  const workingDirectory = resolveWorkingDirectory(inputs.workingDirectory);
  const configPath = normalizeConfigPath(inputs.configPath, workingDirectory);
  const contractPath = normalizeContractPath(inputs.contractPath, workingDirectory);
  const outputPath = normalizeOutputPath(inputs.outputPath, workingDirectory);
  const extraArgs = parseExtraArgs(inputs.extraArgs);

  validatePublishRequirements(publishMode, tokens);

  return {
    configPath,
    contractPath,
    outputPath,
    publishMode,
    dryRun,
    workingDirectory,
    extraArgs,
    cliArgs: buildCliArgs({
      configPath,
      contractPath,
      outputPath,
      publishMode,
      dryRun,
      extraArgs,
    }),
  };
}

function parsePublishMode(rawValue) {
  const normalized = rawValue.trim().toLowerCase();

  if (!normalized) {
    return 'none';
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error(
      `Invalid publish-mode "${rawValue}". Use a lowercase identifier such as none, npm, github-packages, yarn, or pnpm.`
    );
  }

  return normalized;
}

function parseBooleanInput(name, rawValue, fallback) {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return fallback;
  }

  const normalized = trimmed.toLowerCase();

  if (TRUE_BOOLEAN_INPUTS.includes(normalized)) {
    return true;
  }

  if (FALSE_BOOLEAN_INPUTS.includes(normalized)) {
    return false;
  }

  throw new Error(
    `Invalid boolean input for ${name}: ${rawValue}. Supported values: ${TRUE_BOOLEAN_INPUTS.concat(FALSE_BOOLEAN_INPUTS).join(', ')}.`
  );
}

function resolveWorkingDirectory(inputPath) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const resolved = path.resolve(workspace, inputPath || '.');

  ensurePathExists(resolved, 'working-directory');

  if (!statSync(resolved).isDirectory()) {
    throw new Error(`working-directory must point to a directory: ${resolved}`);
  }

  return resolved;
}

function normalizeConfigPath(rawValue, cwd) {
  if (!rawValue.trim()) {
    return '';
  }

  if (looksLikeHttpUrl(rawValue) || looksLikeUri(rawValue)) {
    throw new Error(`config-path must be a local filesystem path: ${rawValue}`);
  }

  const resolved = path.resolve(cwd, rawValue);
  ensurePathExists(resolved, 'config-path');

  if (statSync(resolved).isDirectory()) {
    throw new Error(`config-path must point to a file, received directory: ${resolved}`);
  }

  return resolved;
}

function normalizeContractPath(rawValue, cwd) {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return '';
  }

  if (/^https?:[^/]/i.test(trimmed)) {
    throw new Error(`contract-path looks malformed: ${trimmed}. Use a full http:// or https:// URL.`);
  }

  if (looksLikeHttpUrl(trimmed)) {
    return normalizeHttpUrl('contract-path', trimmed);
  }

  if (looksLikeUri(trimmed)) {
    throw new Error(`contract-path must be a local path or an http/https URL: ${trimmed}`);
  }

  const resolved = path.resolve(cwd, trimmed);
  ensurePathExists(resolved, 'contract-path');

  if (statSync(resolved).isDirectory()) {
    throw new Error(`contract-path must point to a file, received directory: ${resolved}`);
  }

  return resolved;
}

function normalizeOutputPath(rawValue, cwd) {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return '';
  }

  if (looksLikeHttpUrl(trimmed) || looksLikeUri(trimmed)) {
    throw new Error(`output-path must be a local filesystem path: ${trimmed}`);
  }

  const resolved = path.resolve(cwd, trimmed);

  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new Error(`output-path must point to a directory or a path that does not exist yet: ${resolved}`);
  }

  return resolved;
}

function normalizeHttpUrl(name, rawValue) {
  let parsed;

  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be a valid http/https URL: ${rawValue}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https: ${rawValue}`);
  }

  if (!parsed.hostname) {
    throw new Error(`${name} must include a hostname: ${rawValue}`);
  }

  return parsed.toString();
}

function parseExtraArgs(rawValue) {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return [];
  }

  let values;

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

    values = parsed.map((item) => item.trim());
  } else {
    values = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (values.length === 1 && /\s/.test(values[0])) {
      throw new Error(
        'extra-args must be a JSON array string or a newline-delimited list so arguments stay explicit.'
      );
    }
  }

  if (values.some((value) => value.length === 0)) {
    throw new Error('extra-args cannot contain empty arguments.');
  }

  if (values.some((value) => /[\0\r\n]/.test(value))) {
    throw new Error('extra-args entries must not contain null bytes or embedded newlines.');
  }

  return values;
}

function validatePublishRequirements(publishMode, tokens) {
  if (publishMode === 'npm' && !tokens.npmToken) {
    throw new Error(
      'publish-mode "npm" requires npm-token or an existing NPM_TOKEN/NODE_AUTH_TOKEN environment variable.'
    );
  }

  if (publishMode === 'github-packages' && !tokens.githubToken) {
    throw new Error(
      'publish-mode "github-packages" requires github-token or an existing GITHUB_TOKEN environment variable.'
    );
  }

  if (!['none', 'npm', 'github-packages'].includes(publishMode)) {
    warning(
      `publish-mode "${publishMode}" is being passed through to the GenX API CLI. Wrapper-level credential checks only apply to npm and github-packages.`
    );
  }
}

function buildCliArgs(options) {
  const args = ['-y', CLI_PACKAGE, 'generate'];

  pushFlag(args, '--config-path', options.configPath);
  pushFlag(args, '--contract-path', options.contractPath);
  pushFlag(args, '--output-path', options.outputPath);
  pushFlag(args, '--publish-mode', options.publishMode);

  if (options.dryRun) {
    args.push('--dry-run');
  }

  args.push(...options.extraArgs);

  return args;
}

function pushFlag(args, flag, value) {
  if (!value) {
    return;
  }

  args.push(flag, value);
}

function buildEnvironment(tokens) {
  const env = { ...process.env };

  if (tokens.npmToken) {
    env.NPM_TOKEN = tokens.npmToken;
    env.NODE_AUTH_TOKEN = tokens.npmToken;
  }

  if (tokens.githubToken) {
    env.GITHUB_TOKEN = tokens.githubToken;
  }

  return env;
}

function runCommand(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    const stdoutBuffer = createTailBuffer(MAX_CAPTURE_CHARS);
    const stderrBuffer = createTailBuffer(MAX_CAPTURE_CHARS);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuffer.append(text);
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuffer.append(text);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        reject(new Error('Unable to start npx. Ensure the runner has Node.js and npx available on PATH.'));
        return;
      }

      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: stdoutBuffer.get(),
        stderr: stderrBuffer.get(),
      });
    });
  });
}

function createTailBuffer(limit) {
  let value = '';

  return {
    append(text) {
      value += text;

      if (value.length > limit) {
        value = value.slice(-limit);
      }
    },
    get() {
      return value;
    },
  };
}

function extractKnownOutputs(stdout, stderr, cwd) {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const payload = extractPayload(stdout, stderr);

  return {
    summary: findPayloadValue(payload, ['summary', 'message']),
    manifestPath:
      normalizeDiscoveredPath(
        findPayloadValue(payload, ['manifestPath', 'manifest_path', 'manifest-path']),
        cwd
      ) || normalizeDiscoveredPath(matchOutputValue(combined, ['manifest-path', 'manifest path', 'manifestPath']), cwd),
    releaseManifestPath:
      normalizeDiscoveredPath(
        findPayloadValue(payload, ['releaseManifestPath', 'release_manifest_path', 'release-manifest-path']),
        cwd
      ) ||
      normalizeDiscoveredPath(
        matchOutputValue(combined, ['release-manifest-path', 'release manifest path', 'releaseManifestPath']),
        cwd
      ),
  };
}

function extractPayload(stdout, stderr) {
  const candidates = [
    stdout.trim(),
    extractTrailingJsonObject(stdout),
    extractTrailingJsonObject(stderr),
    lastNonEmptyLine(stdout),
    lastNonEmptyLine(stderr),
    stderr.trim(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);

    if (isRecord(parsed)) {
      return parsed;
    }
  }

  return {};
}

function extractTrailingJsonObject(text) {
  const trimmed = text.trim();

  if (!trimmed) {
    return '';
  }

  for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
    const candidate = trimmed.slice(index).trim();

    if (isRecord(tryParseJson(candidate))) {
      return candidate;
    }
  }

  return '';
}

function lastNonEmptyLine(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || '';
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findPayloadValue(payload, keys) {
  const roots = [payload, payload.outputs, payload.result, payload.data].filter(isRecord);

  for (const root of roots) {
    for (const key of keys) {
      if (
        Object.prototype.hasOwnProperty.call(root, key) &&
        root[key] !== undefined &&
        root[key] !== null &&
        root[key] !== ''
      ) {
        return String(root[key]).trim();
      }
    }
  }

  return '';
}

function matchOutputValue(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:=]\\s*(.+)`, 'i');
    const match = text.match(pattern);

    if (match?.[1]) {
      return cleanMatchedValue(match[1]);
    }
  }

  return '';
}

function cleanMatchedValue(value) {
  return value.trim().replace(/^["'`]+|["'`]+$/g, '');
}

function normalizeDiscoveredPath(value, cwd) {
  if (!value) {
    return '';
  }

  if (looksLikeHttpUrl(value) || path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(cwd, value);
}

function buildSuccessSummary(options) {
  const dryRunSuffix = options.dryRun ? ' as a dry run' : '';
  const outputSuffix = options.outputPath ? ` Output path: ${options.outputPath}.` : '';

  return `GenX API CLI completed successfully${dryRunSuffix} in ${options.workingDirectory}.${outputSuffix}`;
}

function buildFailureMessage(result, commandOutput, options) {
  const exitStatus = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
  const lines = [
    `GenX API CLI failed with ${exitStatus}.`,
    `Command: ${commandOutput}`,
    `Working directory: ${options.workingDirectory}`,
  ];

  if (options.outputPath) {
    lines.push(`Output path: ${options.outputPath}`);
  }

  if (options.publishMode === 'npm') {
    lines.push('Check npm authentication and package publish permissions.');
  } else if (options.publishMode === 'github-packages') {
    lines.push('Check github-token permissions and GitHub Packages publish access.');
  } else {
    lines.push('Check config-path, contract-path, output-path, and extra-args.');
  }

  lines.push('Recent CLI output:');
  lines.push(extractFailureTail(result.stderr, result.stdout));

  return lines.join('\n');
}

function extractFailureTail(stderr, stdout) {
  const combined = [stderr, stdout].filter(Boolean).join('\n').trim();

  if (!combined) {
    return 'The CLI did not provide additional output.';
  }

  return combined.split(/\r?\n/).slice(-30).join('\n');
}

function buildStepSummary(details) {
  const lines = [
    '### GenX API',
    '',
    `- Outcome: ${details.outcome}`,
    `- Command intent: ${COMMAND_INTENT}`,
    `- Command: \`${details.command}\``,
    `- Working directory: \`${details.workingDirectory}\``,
    `- Publish mode: \`${details.publishMode}\``,
    `- Dry run: \`${details.dryRun ? 'true' : 'false'}\``,
  ];

  if (details.outputPath) {
    lines.push(`- Output path: \`${details.outputPath}\``);
  }

  if (details.manifestPath) {
    lines.push(`- Manifest path: \`${details.manifestPath}\``);
  }

  if (details.releaseManifestPath) {
    lines.push(`- Release manifest path: \`${details.releaseManifestPath}\``);
  }

  lines.push('', details.summary, '', '');

  return lines.join('\n');
}

function setOutputs(outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    setOutput(name, value);
  }
}

function setOutput(name, value) {
  if (!value) {
    return;
  }

  const outputFile = process.env.GITHUB_OUTPUT;

  if (!outputFile) {
    return;
  }

  appendEnvFile(outputFile, name, value);
}

function writeStepSummary(content) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryFile) {
    return;
  }

  appendFileSync(summaryFile, content);
}

function appendEnvFile(filePath, name, value) {
  const delimiter = `genxapi_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function formatCommand(command, args, extraArgCount) {
  const extraStart = Math.max(args.length - extraArgCount, 0);

  const displayArgs = args.map((value, index, allArgs) => {
    if (extraArgCount > 0 && index >= extraStart) {
      return '[EXTRA_ARG]';
    }

    return redactArg(value, index, allArgs);
  });

  return [command].concat(displayArgs).map(quoteForDisplay).join(' ');
}

function redactArg(value, index, allArgs) {
  const previous = index > 0 ? allArgs[index - 1] : '';

  if (looksSensitiveFlag(previous) || looksSensitiveValue(value)) {
    return '[REDACTED]';
  }

  return value;
}

function looksSensitiveFlag(value) {
  return /token|secret|password|key/i.test(value || '');
}

function looksSensitiveValue(value) {
  return /token|secret|password/i.test(value || '');
}

function quoteForDisplay(value) {
  if (value === '') {
    return '""';
  }

  if (/^[A-Za-z0-9_@./:=+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function logStart(options, commandOutput) {
  log('GenX API action validated inputs.');
  log(`Working directory: ${options.workingDirectory}`);
  log(`Publish mode: ${options.publishMode} | Dry run: ${options.dryRun ? 'true' : 'false'}`);

  if (options.outputPath) {
    log(`Output path: ${options.outputPath}`);
  }

  log(`Command: ${commandOutput}`);
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function addMask(value) {
  process.stdout.write(`::add-mask::${escapeCommandValue(value)}\n`);
}

function warning(message) {
  process.stdout.write(`::warning::${escapeCommandValue(message)}\n`);
}

function fail(message) {
  process.stdout.write(`::error::${escapeCommandValue(message)}\n`);
  process.exitCode = 1;
}

function log(message) {
  process.stdout.write(`[genxapi-action] ${message}\n`);
}

function escapeCommandValue(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensurePathExists(resolvedPath, name) {
  if (!existsSync(resolvedPath)) {
    throw new Error(`${name} does not exist: ${resolvedPath}`);
  }
}

function looksLikeHttpUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikeUri(value) {
  const trimmed = value.trim();

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
