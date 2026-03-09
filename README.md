# GenX API GitHub Action

`genxapi-action` is the official GitHub Action wrapper for GenX API. It is intentionally thin: it reads workflow inputs, runs `@genxapi/cli@latest` with `npx`, forwards logs, and exposes a small set of outputs for CI usage.

GenX API is the product. This repository is only the GitHub Action wrapper around that product.

For product documentation and official information, see [genxapi.dev](https://genxapi.dev).

## Runtime Model

This action runs the GenX API CLI directly:

```text
npx -y @genxapi/cli@latest generate ...
```

It does not reimplement templates, manifests, orchestration, diffing, or publish logic. Those stay in GenX API itself.

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `config-path` | No |  | Passed as `--config-path <value>`. |
| `contract-path` | No |  | Passed as `--contract-path <value>`. |
| `output-path` | No |  | Passed as `--output-path <value>`. |
| `publish-mode` | No | `none` | Passed as `--publish-mode <value>`. |
| `dry-run` | No | `false` | Adds `--dry-run`. |
| `working-directory` | No | `.` | Used as the process working directory. |
| `extra-args` | No |  | JSON array string or newline-delimited list of additional CLI args. |
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

No secret is always required by the wrapper itself.

- Use `npm-token` when the selected publish flow needs npm credentials.
- Use `github-token` when the selected publish flow needs GitHub credentials.

The action masks provided token values before invoking the CLI.

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

## Node Runtime Note

`.nvmrc` is pinned to Node `25.7.0`, which was the latest stable Node.js release at implementation time. GitHub Actions metadata currently supports `node20` and `node24` for JavaScript actions, so `action.yml` uses `node24` as the closest supported runtime while keeping the repository itself pinned to the newest stable Node release.

## Design Decisions

- Plain JavaScript only, with a single root `index.js`
- No `dist/` directory and no build step
- No `@actions/core` or other helper libraries
- No third-party runtime tools beyond `npx` fetching `@genxapi/cli@latest`
- Best-effort output extraction only; GenX API CLI remains the source of truth

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](/Users/eduardo/projects/genxapi-action/LICENSE).
