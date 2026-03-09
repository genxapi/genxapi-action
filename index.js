const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const CLI_PACKAGE = '@genxapi/cli@latest';
const VALID_PUBLISH_MODES = new Set(['none', 'npm', 'github-packages']);

main();

async function main() {
  let inputs = {
    publishMode: 'none',
    dryRun: false,
  };
  let workingDirectory = '';
  let commandOutput = `npx -y ${CLI_PACKAGE} generate`;

  try {
    inputs = readInputs();
    validateInputs(inputs);

    workingDirectory = resolveWorkingDirectory(inputs.workingDirectory);
    const cliArgs = buildCliArgs(inputs);
    commandOutput = formatCommand(getNpxCommand(), cliArgs, inputs.extraArgs.length);
    const env = buildEnvironment(inputs);

    setOutput('command', commandOutput);
    setOutput('working-directory', workingDirectory);

    log(`Running GenX API from ${workingDirectory}`);
    log(`Command: ${commandOutput}`);

    const result = await runCommand(getNpxCommand(), cliArgs, workingDirectory, env);

    if (result.exitCode !== 0) {
      const message = buildFailureMessage(result, commandOutput, workingDirectory);
      setOutput('summary', message);
      writeStepSummary(buildStepSummary({
        outcome: 'failed',
        command: commandOutput,
        workingDirectory,
        publishMode: inputs.publishMode,
        dryRun: inputs.dryRun,
        summary: message,
      }));
      fail(message);
      return;
    }

    const discovered = extractKnownOutputs(result.stdout, result.stderr, workingDirectory);
    const summary = discovered.summary || buildSuccessSummary(inputs, workingDirectory);

    setOutput('summary', summary);
    setOutput('manifest-path', discovered.manifestPath);
    setOutput('release-manifest-path', discovered.releaseManifestPath);

    writeStepSummary(buildStepSummary({
      outcome: 'succeeded',
      command: commandOutput,
      workingDirectory,
      publishMode: inputs.publishMode,
      dryRun: inputs.dryRun,
      manifestPath: discovered.manifestPath,
      releaseManifestPath: discovered.releaseManifestPath,
      summary,
    }));

    log(summary);
  } catch (error) {
    const summary = `GenX API action failed. ${formatError(error)}`;

    setOutput('command', commandOutput);

    if (workingDirectory) {
      setOutput('working-directory', workingDirectory);
    }

    setOutput('summary', summary);
    writeStepSummary(buildStepSummary({
      outcome: 'failed',
      command: commandOutput,
      workingDirectory: workingDirectory || 'unresolved',
      publishMode: inputs.publishMode,
      dryRun: inputs.dryRun,
      summary,
    }));
    fail(summary);
  }
}

function readInputs() {
  return {
    configPath: readInput('config-path'),
    contractPath: readInput('contract-path'),
    outputPath: readInput('output-path'),
    publishMode: readInput('publish-mode', 'none').toLowerCase(),
    dryRun: readBooleanInput('dry-run', false),
    workingDirectory: readInput('working-directory', '.'),
    extraArgs: parseExtraArgs(readInput('extra-args')),
    npmToken: readInput('npm-token'),
    githubToken: readInput('github-token'),
  };
}

function readInput(name, fallback) {
  const variants = new Set([
    `INPUT_${name.replace(/ /g, '_').toUpperCase()}`,
    `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`,
  ]);

  for (const key of variants) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      return String(process.env[key] || '').trim();
    }
  }

  return fallback || '';
}

function readBooleanInput(name, fallback) {
  const value = readInput(name, '');

  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean input for ${name}: ${value}. Use true or false.`);
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
    throw new Error('extra-args must be a JSON array string or newline-delimited list so arguments stay explicit.');
  }

  return lines;
}

function validateInputs(inputs) {
  if (!VALID_PUBLISH_MODES.has(inputs.publishMode)) {
    throw new Error(
      `Unsupported publish-mode "${inputs.publishMode}". Supported values: ${Array.from(VALID_PUBLISH_MODES).join(', ')}.`
    );
  }

  if (inputs.publishMode === 'npm' && !inputs.npmToken) {
    warning('publish-mode is npm but npm-token was not provided. The CLI will rely on existing npm authentication.');
  }

  if (inputs.publishMode === 'github-packages' && !inputs.githubToken) {
    warning(
      'publish-mode is github-packages but github-token was not provided. The CLI will rely on existing GitHub authentication.'
    );
  }
}

function resolveWorkingDirectory(inputPath) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const resolved = path.resolve(workspace, inputPath || '.');

  if (!fs.existsSync(resolved)) {
    throw new Error(`working-directory does not exist: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`working-directory is not a directory: ${resolved}`);
  }

  return resolved;
}

function buildCliArgs(inputs) {
  const args = ['-y', CLI_PACKAGE, 'generate'];

  pushFlag(args, '--config-path', inputs.configPath);
  pushFlag(args, '--contract-path', inputs.contractPath);
  pushFlag(args, '--output-path', inputs.outputPath);
  pushFlag(args, '--publish-mode', inputs.publishMode);

  if (inputs.dryRun) {
    args.push('--dry-run');
  }

  args.push(...inputs.extraArgs);

  return args;
}

function pushFlag(args, flag, value) {
  if (!value) {
    return;
  }

  args.push(flag, value);
}

function buildEnvironment(inputs) {
  const env = { ...process.env };

  if (inputs.npmToken) {
    addMask(inputs.npmToken);
    env.NPM_TOKEN = inputs.npmToken;
    env.NODE_AUTH_TOKEN = inputs.npmToken;
  }

  if (inputs.githubToken) {
    addMask(inputs.githubToken);
    env.GITHUB_TOKEN = inputs.githubToken;
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
        stdout,
        stderr,
      });
    });
  });
}

function extractKnownOutputs(stdout, stderr, cwd) {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const payload = extractPayload(stdout, stderr);

  return {
    summary: findPayloadValue(payload, ['summary', 'message']) || '',
    manifestPath:
      normalizePath(findPayloadValue(payload, ['manifestPath', 'manifest_path', 'manifest-path']), cwd) ||
      normalizePath(matchOutputValue(combined, ['manifest-path', 'manifest path', 'manifestPath']), cwd),
    releaseManifestPath:
      normalizePath(
        findPayloadValue(payload, ['releaseManifestPath', 'release_manifest_path', 'release-manifest-path']),
        cwd
      ) ||
      normalizePath(
        matchOutputValue(combined, ['release-manifest-path', 'release manifest path', 'releaseManifestPath']),
        cwd
      ),
  };
}

function extractPayload(stdout, stderr) {
  const candidates = [];
  const stdoutTrimmed = stdout.trim();
  const stderrTrimmed = stderr.trim();

  if (stdoutTrimmed) {
    candidates.push(stdoutTrimmed);
    const stdoutLastLine = stdoutTrimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();

    if (stdoutLastLine) {
      candidates.push(stdoutLastLine);
    }
  }

  if (stderrTrimmed) {
    const stderrLastLine = stderrTrimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();

    if (stderrLastLine) {
      candidates.push(stderrLastLine);
    }
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
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

function findPayloadValue(payload, keys) {
  const roots = [payload, payload.outputs, payload.result, payload.data].filter(isRecord);

  for (const root of roots) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(root, key) && root[key] !== undefined && root[key] !== null && root[key] !== '') {
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

    if (match && match[1]) {
      return cleanMatchedValue(match[1]);
    }
  }

  return '';
}

function cleanMatchedValue(value) {
  return value.trim().replace(/^["'`]+|["'`]+$/g, '');
}

function normalizePath(value, cwd) {
  if (!value) {
    return '';
  }

  if (/^https?:\/\//i.test(value) || path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(cwd, value);
}

function buildSuccessSummary(inputs, workingDirectory) {
  const suffix = inputs.dryRun ? ' as a dry run' : '';
  return `GenX API CLI completed successfully${suffix} in ${workingDirectory}.`;
}

function buildFailureMessage(result, commandOutput, workingDirectory) {
  const exitStatus = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
  const combined = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  const tail = combined ? combined.split(/\r?\n/).slice(-20).join('\n') : 'The CLI did not provide additional output.';

  return [
    `GenX API CLI failed with ${exitStatus}.`,
    `Command: ${commandOutput}`,
    `Working directory: ${workingDirectory}`,
    'Check config-path, contract-path, publish-mode, and extra-args.',
    tail,
  ].join('\n');
}

function buildStepSummary(details) {
  const lines = [
    '### GenX API',
    '',
    `- Outcome: ${details.outcome}`,
    `- Command: \`${details.command}\``,
    `- Working directory: \`${details.workingDirectory}\``,
    `- Publish mode: \`${details.publishMode}\``,
    `- Dry run: \`${details.dryRun ? 'true' : 'false'}\``,
  ];

  if (details.manifestPath) {
    lines.push(`- Manifest path: \`${details.manifestPath}\``);
  }

  if (details.releaseManifestPath) {
    lines.push(`- Release manifest path: \`${details.releaseManifestPath}\``);
  }

  lines.push('', details.summary, '');

  return lines.join('\n');
}

function setOutput(name, value) {
  if (!value) {
    return;
  }

  const outputFile = process.env.GITHUB_OUTPUT;

  if (!outputFile) {
    return;
  }

  appendEnvFile(outputFile, name, String(value));
}

function writeStepSummary(content) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryFile) {
    return;
  }

  fs.appendFileSync(summaryFile, content);
}

function appendEnvFile(filePath, name, value) {
  const delimiter = `genxapi_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  fs.appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
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
  process.stdout.write(`${message}\n`);
}

function escapeCommandValue(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
