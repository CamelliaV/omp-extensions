# omp-ext-camellia

Personal [omp](https://github.com/can1357/oh-my-pi) runtime extensions, installable as an omp plugin.

## Contents

| Extension                                | What it does                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/router-deepseek-dsh-spec.ts` | DSH spec router for DeepSeek V4 Pro/Flash: anchors the first turn to a minimal tool set + lean tool schemas, classifies the task, then promotes to the full set. |

## Install on another machine

```bash
omp plugin install github:CamelliaV/omp-extensions
```

No credentials needed — the repository is public and bun resolves this through
the GitHub tarball API. Pin a ref instead of tracking the default branch:

```bash
omp plugin install "github:CamelliaV/omp-extensions#<commit>"
```

If the repository is ever made private again, every `github.com` HTTPS and
`github:` shorthand spec starts returning 404 — bun's tarball path never sends
credentials, and `GITHUB_TOKEN` / `BUN_CONFIG_TOKEN` do not change that. Only an
SSH spec clones, and it needs a key registered with GitHub
(`gh auth setup-git` is not enough; it only configures the HTTPS helper):

```bash
omp plugin install git@github.com:CamelliaV/omp-extensions.git
```

Then restart the session — extension modules bind at startup, so
`/reload-plugins` is not enough for a newly installed extension.

Verify:

```bash
omp plugin list          # omp-ext-camellia, enabled
omp plugin doctor        # manifest + on-disk entry check
```

`omp plugin install` itself already imports every declared extension entry and
fails the install if the factory throws, so a successful install is proof the
module loads. Inside a session, `/dsh-router-status` reports the router state.

Upgrade later:

```bash
omp plugin upgrade omp-ext-camellia
```

Uninstall:

```bash
omp plugin uninstall omp-ext-camellia
```

## This machine (source of truth)

`~/.omp/agent/extensions/router-deepseek-dsh-spec.ts` is a symlink into this
repository, so edits here are live in the next session and `git push` publishes
them. Do **not** also `omp plugin install` on this machine: extension
de-duplication is by absolute path, the symlink and the plugin copy resolve
differently, and the router would load twice.

## Requirement: a DeepSeek V4 model must be reachable

The router only activates when the active model id (last `/` segment,
lowercased) starts with `deepseek-v4-pro` or `deepseek-v4-flash`. Any provider
serving such an id works; see `models.example.yml` for the shape. Credentials
are **not** part of this repository — add your own `apiKey` in
`~/.omp/agent/models.yml` on each machine.

With no matching model selected, the extension stays inert (it only restores the
baseline tool set), so installing it is harmless on machines without DeepSeek
access.

## Routing behavior

- **Pro** (`deepseek-v4-pro*`): first turn gets a terse system prompt, `bash` +
  `read` only, and lean tool schemas injected at `before_provider_request`;
  missing `i` intents are backfilled. Promotes to the full tool set on the first
  tool call or at turn end.
- **Flash** (`deepseek-v4-flash*`): the first user message is classified into
  one of three bands, each with its own persona and first-turn tool set:
  - `spec` — fix/debug/refactor wording → inspect-first, plural planning voice
  - `react` — build/create wording → hands-on production
  - `weak` — neither → self-classifying prompt, widest first-turn tools
- Router phase is persisted as a session custom entry
  (`io.github.soeur.dsh-router-spec.omp.v1`), so resume, branch, and session
  switch restore the correct tool set instead of re-anchoring.
