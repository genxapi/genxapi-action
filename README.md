# GenX API GitHub Action

`genxapi-action` is the official GitHub Action wrapper for running GenX API in GitHub workflows. It is a thin automation surface over the published GenX API CLI, intended for backend-initiated contract-driven generation and optional package publication in CI.

GenX API is the product. This repository is the GitHub Action that executes that product safely inside Actions.

For core product documentation and official GenX API information, see [genxapi.dev](https://genxapi.dev).

## How It Relates To The GenX API CLI

This action does not reimplement templates, orchestration, manifest logic, diffing, or publish behavior. It resolves GitHub Action inputs, invokes the published `genxapi` CLI with explicit arguments, passes through only the minimum required environment, and maps machine-readable CLI output back into GitHub Action outputs.

The action currently executes the CLI in this shape:

```text
npx --yes --package genxapi@<genxapi-version> -- genxapi generate --json [mapped flags...]
```

This wrapper assumes the core product exposes a stable `genxapi generate --json` surface. If the CLI contract changes, update the wrapper to match the published CLI rather than recreating product behavior here.

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `genxapi-version` | No | `0.1.0` | Explicit CLI version to install and execute. Avoids `latest` by default. |
| `config-path` | No |  | Forwarded as `--config <path>`. |
| `contract-path` | No |  | Forwarded as `--contract <path-or-url>`. |
| `output-path` | No |  | Forwarded as `--output <path>`. |
| `publish-mode` | No | `none` | Wrapper-supported values: `none`, `npm`, `github-packages`. Forwarded as `--publish-mode <value>`. |
| `dry-run` | No | `false` | Adds `--dry-run`. |
| `working-directory` | No | `.` | Directory used as the CLI process `cwd`. |
| `extra-args` | No |  | Controlled escape hatch. Provide a JSON array string or newline-delimited list. |
| `npm-token` | No |  | Passed only as `NPM_TOKEN` and `NODE_AUTH_TOKEN` when provided. |
| `github-token` | No |  | Passed only as `GITHUB_TOKEN` when provided. |

## Outputs

The action prefers structured JSON emitted by `genxapi generate --json`. When those fields are present, it maps them directly to GitHub Action outputs.

| Output | Description |
| --- | --- |
| `resolved-contract-source` | Resolved contract source reported by the CLI. |
| `template` | Template identifier reported by the CLI. |
| `output-path` | Output path reported by the CLI, or the resolved input path when available. |
| `manifest-path` | Manifest path reported by the CLI. |
| `published-package-name` | Published package name reported by the CLI. |
| `published-package-version` | Published package version reported by the CLI. |
| `release-manifest-path` | Release manifest path reported by the CLI. |
| `summary` | Human-readable execution summary. |

## Required Secrets

No secret is always required by the wrapper itself.

- Use `npm-token` when `publish-mode: npm` and the CLI needs npm publication credentials.
- Use `github-token` when `publish-mode: github-packages` or another GitHub-aware CLI flow needs it.

The action masks provided secrets with GitHub Actions secret handling before spawning the CLI.

## Example Usage

Basic generation:

```yaml
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          genxapi-version: 0.1.0
          config-path: genxapi.config.json
          contract-path: https://api.example.com/openapi.json
          output-path: ./generated/sdk
```

Using a local contract from a subdirectory:

```yaml
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          working-directory: ./services/catalog
          contract-path: ./contracts/catalog-openapi.yaml
          output-path: ./artifacts/catalog-client
```

## Publish Mode Examples

Publish to npm:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          genxapi-version: 0.1.0
          config-path: genxapi.config.json
          publish-mode: npm
          npm-token: ${{ secrets.NPM_TOKEN }}
```

Publish to GitHub Packages:

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
          genxapi-version: 0.1.0
          config-path: genxapi.config.json
          publish-mode: github-packages
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Dry-Run Example

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: genxapi/genxapi-action@v1
        with:
          genxapi-version: 0.1.0
          config-path: genxapi.config.json
          contract-path: ./contracts/openapi.yaml
          dry-run: true
```

## CLI Mapping

The wrapper keeps its contract deliberately small:

| Action surface | CLI mapping |
| --- | --- |
| `genxapi-version` | `npx --package genxapi@<version>` |
| `config-path` | `--config <path>` |
| `contract-path` | `--contract <path-or-url>` |
| `output-path` | `--output <path>` |
| `publish-mode` | `--publish-mode <value>` |
| `dry-run` | `--dry-run` |
| `working-directory` | Process `cwd` |
| `extra-args` | Appended as explicit argv entries after safe parsing |
| `npm-token` | `NPM_TOKEN` and `NODE_AUTH_TOKEN` env vars |
| `github-token` | `GITHUB_TOKEN` env var |

Expected structured output contract:

```json
{
  "resolvedContractSource": "...",
  "template": "...",
  "outputPath": "...",
  "manifestPath": "...",
  "publishedPackageName": "...",
  "publishedPackageVersion": "...",
  "releaseManifestPath": "...",
  "summary": "..."
}
```

If the CLI emits those fields in camelCase, snake_case, or kebab-case at the top level or inside a top-level `outputs` or `result` object, the action maps them to GitHub Action outputs.

## When To Use This Action Vs Running The CLI Directly

Use this action when generation belongs inside a GitHub workflow and you want a stable Marketplace-oriented wrapper with GitHub-native inputs, outputs, secret handling, and log formatting.

Run the CLI directly when you need local development flows, richer scripting outside GitHub Actions, or product features that should remain exposed first through the core `genxapi` repository and CLI.

## Marketplace Readiness

- Single root `action.yml` with committed `dist/` entrypoint
- Public-repository-friendly metadata and branding
- Explicit CLI version pin by default
- Documentation focused on GitHub Action usage rather than duplicating core product docs

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](/Users/eduardo/projects/genxapi-action/LICENSE).

## Manual Testing

Rebuild the committed action bundle after editing source:

```bash
npm install
npm run bundle
```

Test from another repository without publishing:

```yaml
jobs:
  smoke-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: genxapi/genxapi-action
          path: ./.github/actions/genxapi
          ref: main
      - uses: ./.github/actions/genxapi
        with:
          genxapi-version: 0.1.0
          config-path: genxapi.config.json
          dry-run: true
```

## Maintenance

New product capabilities should land in `genxapi` first. This repository should only expose stable CLI capabilities that are useful in GitHub workflows.

If a feature would require this action to understand consumer app internals, frontend structure, dist-path imports, or generation logic, that feature belongs in the CLI instead of this wrapper.
