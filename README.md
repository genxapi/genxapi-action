# GenX API GitHub Action

`genxapi-action` is the official GitHub Action wrapper for GenX API. It stays intentionally thin: it reads workflow inputs, validates them early, runs `@genxapi/cli@latest` with `npx`, streams CLI logs, and exposes a small set of outputs for workflow usage.

GenX API is the product. This repository is only the GitHub Action wrapper around that product.

For product documentation and official information, see [genxapi.dev](https://genxapi.dev).

## Runtime Model

This action runs the GenX API CLI directly:

```text
npx -y @genxapi/cli@latest generate ...
```

It does not reimplement templates, manifests, orchestration, diffing, or publish logic. Those stay in GenX API itself.

## Repository Structure

- `src/index.ts`: TypeScript source for the action wrapper.
- `dist/index.js`: committed JavaScript runtime used by GitHub Actions.
- `action.yml`: action metadata pointing at the compiled runtime.

Users do not need to build the repository before using the action.

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `config-path` | No |  | Local config file path. The action resolves it from `working-directory` and fails fast if it does not exist. |
| `contract-path` | No |  | Local contract file path or remote `http/https` URL. Local paths are validated before execution. |
| `output-path` | No |  | Output directory path. Relative values are normalized from `working-directory`. |
| `publish-mode` | No | `none` | Passed as `--publish-mode <value>`. Supported values: `none`, `npm`, `github-packages`. |
| `dry-run` | No | `false` | Safe boolean parsing. Accepts `true/false`, `1/0`, `yes/no`, `on/off`, `y/n`. |
| `working-directory` | No | `.` | Process working directory. Resolved from `GITHUB_WORKSPACE` and validated before the CLI starts. |
| `extra-args` | No |  | Additional CLI args as a JSON array string or newline-delimited list. Shell-style single-line splitting is intentionally rejected. |
| `npm-token` | No |  | Exposed as `NPM_TOKEN` and `NODE_AUTH_TOKEN` when provided. |
| `github-token` | No |  | Exposed as `GITHUB_TOKEN` when provided. |

## Outputs

| Output | Description |
| --- | --- |
| `summary` | Short execution summary. |
| `command` | Sanitized command string executed by the action. |
| `working-directory` | Resolved working directory used for execution. |
| `manifest-path` | Manifest path when the CLI reports one. |
| `release-manifest-path` | Release manifest path when the CLI reports one. |

## Required Secrets

No secret is always required by the wrapper itself, but publish flows are validated early:

- `publish-mode: npm` requires `npm-token` or an existing `NPM_TOKEN` / `NODE_AUTH_TOKEN` environment variable.
- `publish-mode: github-packages` requires `github-token` or an existing `GITHUB_TOKEN` environment variable.

The action masks resolved token values before any logging occurs.

## Example Usage

```yaml
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          config-path: genxapi.config.json
          contract-path: https://api.example.com/openapi.json
          output-path: ./generated/sdk
```

## Dry Run Example

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          config-path: genxapi.config.json
          contract-path: ./contracts/openapi.yaml
          dry-run: true
```

## Publish Example

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          config-path: genxapi.config.json
          publish-mode: github-packages
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Validation And Workflow UX

- Paths are normalized before execution so logs, summaries, and outputs use consistent values.
- The CLI is executed with `spawn`, explicit argv arrays, and live stdout/stderr streaming.
- The action writes a concise step summary to `GITHUB_STEP_SUMMARY` with command intent, working directory, dry-run state, publish mode, output path, and any discovered manifest paths.
- Extra args remain available as an escape hatch, but they must be provided in an explicit list form.

## Common Workflow Mistakes

- Missing `working-directory`: the action fails before invoking the CLI and shows the resolved path it checked.
- Missing local `config-path` or `contract-path`: the action fails early with the normalized file path.
- Invalid `publish-mode`: the action lists the supported values.
- Missing publish credentials: the action explains which token input or environment variable is required.
- Ambiguous `extra-args`: the action rejects shell-style single-line strings and asks for JSON array or newline-delimited input.

## Node Runtime Note

`.nvmrc` is pinned to Node `25.8.0`, which was the latest stable Node.js release verified during implementation. GitHub Actions metadata supports `node20` and `node24` for JavaScript actions, so `action.yml` uses `node24` as the closest supported runtime while the repository itself stays pinned to the latest verified stable Node release.

## Design Constraints

- Thin wrapper only: the action keeps calling `npx -y @genxapi/cli@latest generate`.
- No GenX API product logic is duplicated here.
- No runtime dependency on `@actions/*` packages.
- Runtime dependencies remain at zero; only TypeScript authoring tooling is added for development.

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
