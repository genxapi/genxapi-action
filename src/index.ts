import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

const CLI_PACKAGE = '@genxapi/cli@latest' as const;
const COMMAND_INTENT = `Run \`${CLI_PACKAGE} generate\``;
const VALID_PUBLISH_MODES = ['none', 'npm', 'github-packages'] as const;
const TRUE_BOOLEAN_INPUTS = ['true', '1', 'yes', 'y', 'on'] as const;
const FALSE_BOOLEAN_INPUTS = ['false', '0', 'no', 'n', 'off'] as const;
const MAX_CAPTURE_CHARS = 256 * 1024;

type PublishMode = (typeof VALID_PUBLISH_MODES)[number];
type BooleanInputLiteral = (typeof TRUE_BOOLEAN_INPUTS)[number] | (typeof FALSE_BOOLEAN_INPUTS)[number];
type StepOutcome = 'succeeded' | 'failed';

type ActionInputs = {
  configPath: string;
  contractPath: string;
  outputPath: string;
  publishMode: string;
  dryRun: string;
  workingDirectory: string;
  extraArgs: string;
  npmToken: string;
  githubToken: string;
};

type ResolvedTokens = {
  npmToken: string;
  githubToken: string;
};

type NormalizedOptions = {
  configPath: string;
  contractPath: string;
  outputPath: string;
  publishMode: PublishMode;
  dryRun: boolean;
  workingDirectory: string;
  extraArgs: string[];
  cliArgs: string[];
};

type ActionOutputs = {
  summary?: string;
  command?: string;
  'working-directory'?: string;
  'manifest-path'?: string;
  'release-manifest-path'?: string;
};

type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type StepSummaryDetails = {
  outcome: StepOutcome;
  command: string;
  workingDirectory: string;
  publishMode: PublishMode;
  dryRun: boolean;
  outputPath?: string;
  manifestPath?: string;
  releaseManifestPath?: string;
  summary: string;
};

type KnownOutputs = {
  summary: string;
  manifestPath: string;
  releaseManifestPath: string;
};

void main();

async function main(): Promise<void> {
  let inputs: ActionInputs = createDefaultInputs();
  let options: NormalizedOptions | null = null;
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

function createDefaultInputs(): ActionInputs {
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

function readInputs(): ActionInputs {
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

function readInput(name: string, fallback = ''): string {
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

function resolveTokens(inputs: ActionInputs): ResolvedTokens {
  return {
    npmToken: inputs.npmToken || process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '',
    githubToken: inputs.githubToken || process.env.GITHUB_TOKEN || '',
  };
}

function maskTokens(tokens: ResolvedTokens): void {
  if (tokens.npmToken) {
    addMask(tokens.npmToken);
  }

  if (tokens.githubToken) {
    addMask(tokens.githubToken);
  }
}

function normalizeOptions(inputs: ActionInputs, tokens: ResolvedTokens): NormalizedOptions {
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

function parsePublishMode(rawValue: string): PublishMode {
  const normalized = rawValue.trim().toLowerCase();

  if ((VALID_PUBLISH_MODES as readonly string[]).includes(normalized)) {
    return normalized as PublishMode;
  }

  throw new Error(
    `Unsupported publish-mode "${rawValue}". Supported values: ${VALID_PUBLISH_MODES.join(', ')}.`
  );
}

function parseBooleanInput(name: string, rawValue: string, fallback: boolean): boolean {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return fallback;
  }

  const normalized = trimmed.toLowerCase() as BooleanInputLiteral;

  if ((TRUE_BOOLEAN_INPUTS as readonly string[]).includes(normalized)) {
    return true;
  }

  if ((FALSE_BOOLEAN_INPUTS as readonly string[]).includes(normalized)) {
    return false;
  }

  throw new Error(
    `Invalid boolean input for ${name}: ${rawValue}. Supported values: ${[...TRUE_BOOLEAN_INPUTS, ...FALSE_BOOLEAN_INPUTS].join(', ')}.`
  );
}

function resolveWorkingDirectory(inputPath: string): string {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const resolved = path.resolve(workspace, inputPath || '.');

  ensurePathExists(resolved, 'working-directory');

  if (!statSync(resolved).isDirectory()) {
    throw new Error(`working-directory must point to a directory: ${resolved}`);
  }

  return resolved;
}

function normalizeConfigPath(rawValue: string, cwd: string): string {
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

function normalizeContractPath(rawValue: string, cwd: string): string {
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

function normalizeOutputPath(rawValue: string, cwd: string): string {
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

function normalizeHttpUrl(name: string, rawValue: string): string {
  let parsed: URL;

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

function parseExtraArgs(rawValue: string): string[] {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return [];
  }

  let values: string[];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;

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

function validatePublishRequirements(publishMode: PublishMode, tokens: ResolvedTokens): void {
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
}

function buildCliArgs(options: {
  configPath: string;
  contractPath: string;
  outputPath: string;
  publishMode: PublishMode;
  dryRun: boolean;
  extraArgs: string[];
}): string[] {
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

function pushFlag(args: string[], flag: string, value: string): void {
  if (!value) {
    return;
  }

  args.push(flag, value);
}

function buildEnvironment(tokens: ResolvedTokens): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (tokens.npmToken) {
    env.NPM_TOKEN = tokens.npmToken;
    env.NODE_AUTH_TOKEN = tokens.npmToken;
  }

  if (tokens.githubToken) {
    env.GITHUB_TOKEN = tokens.githubToken;
  }

  return env;
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
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

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuffer.append(text);
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer.append(text);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      if ('code' in error && error.code === 'ENOENT') {
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

function createTailBuffer(limit: number): { append: (text: string) => void; get: () => string } {
  let value = '';

  return {
    append(text: string) {
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

function extractKnownOutputs(stdout: string, stderr: string, cwd: string): KnownOutputs {
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

function extractPayload(stdout: string, stderr: string): Record<string, unknown> {
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

function extractTrailingJsonObject(text: string): string {
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

function lastNonEmptyLine(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || '';
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findPayloadValue(payload: Record<string, unknown>, keys: string[]): string {
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

function matchOutputValue(text: string, labels: string[]): string {
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:=]\\s*(.+)`, 'i');
    const match = text.match(pattern);

    if (match?.[1]) {
      return cleanMatchedValue(match[1]);
    }
  }

  return '';
}

function cleanMatchedValue(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, '');
}

function normalizeDiscoveredPath(value: string, cwd: string): string {
  if (!value) {
    return '';
  }

  if (looksLikeHttpUrl(value) || path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(cwd, value);
}

function buildSuccessSummary(options: NormalizedOptions): string {
  const dryRunSuffix = options.dryRun ? ' as a dry run' : '';
  const outputSuffix = options.outputPath ? ` Output path: ${options.outputPath}.` : '';

  return `GenX API CLI completed successfully${dryRunSuffix} in ${options.workingDirectory}.${outputSuffix}`;
}

function buildFailureMessage(result: RunResult, commandOutput: string, options: NormalizedOptions): string {
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

function extractFailureTail(stderr: string, stdout: string): string {
  const combined = [stderr, stdout].filter(Boolean).join('\n').trim();

  if (!combined) {
    return 'The CLI did not provide additional output.';
  }

  return combined.split(/\r?\n/).slice(-30).join('\n');
}

function buildStepSummary(details: StepSummaryDetails): string {
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

function setOutputs(outputs: ActionOutputs): void {
  for (const [name, value] of Object.entries(outputs)) {
    setOutput(name, value);
  }
}

function setOutput(name: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  const outputFile = process.env.GITHUB_OUTPUT;

  if (!outputFile) {
    return;
  }

  appendEnvFile(outputFile, name, value);
}

function writeStepSummary(content: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryFile) {
    return;
  }

  appendFileSync(summaryFile, content);
}

function appendEnvFile(filePath: string, name: string, value: string): void {
  const delimiter = `genxapi_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function formatCommand(command: string, args: string[], extraArgCount: number): string {
  const extraStart = Math.max(args.length - extraArgCount, 0);

  const displayArgs = args.map((value, index, allArgs) => {
    if (extraArgCount > 0 && index >= extraStart) {
      return '[EXTRA_ARG]';
    }

    return redactArg(value, index, allArgs);
  });

  return [command].concat(displayArgs).map(quoteForDisplay).join(' ');
}

function redactArg(value: string, index: number, allArgs: string[]): string {
  const previous = index > 0 ? allArgs[index - 1] : '';

  if (looksSensitiveFlag(previous) || looksSensitiveValue(value)) {
    return '[REDACTED]';
  }

  return value;
}

function looksSensitiveFlag(value: string): boolean {
  return /token|secret|password|key/i.test(value || '');
}

function looksSensitiveValue(value: string): boolean {
  return /token|secret|password/i.test(value || '');
}

function quoteForDisplay(value: string): string {
  if (value === '') {
    return '""';
  }

  if (/^[A-Za-z0-9_@./:=+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function logStart(options: NormalizedOptions, commandOutput: string): void {
  log(`GenX API action validated inputs.`);
  log(`Working directory: ${options.workingDirectory}`);
  log(`Publish mode: ${options.publishMode} | Dry run: ${options.dryRun ? 'true' : 'false'}`);

  if (options.outputPath) {
    log(`Output path: ${options.outputPath}`);
  }

  log(`Command: ${commandOutput}`);
}

function getNpxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function addMask(value: string): void {
  process.stdout.write(`::add-mask::${escapeCommandValue(value)}\n`);
}

function fail(message: string): void {
  process.stdout.write(`::error::${escapeCommandValue(message)}\n`);
  process.exitCode = 1;
}

function log(message: string): void {
  process.stdout.write(`[genxapi-action] ${message}\n`);
}

function escapeCommandValue(value: string): string {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensurePathExists(resolvedPath: string, name: string): void {
  if (!existsSync(resolvedPath)) {
    throw new Error(`${name} does not exist: ${resolvedPath}`);
  }
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikeUri(value: string): boolean {
  const trimmed = value.trim();

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
