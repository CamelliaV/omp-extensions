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

Pin a commit or tag instead of tracking the default branch:

```bash
omp plugin install github:CamelliaV/omp-extensions#v0.1.0
```

Then restart the session — extension modules are bound at startup, so
`/reload-plugins` is not enough for a newly installed extension.

Verify:

```bash
omp plugin list          # camellia-omp-extensions, enabled
omp plugin doctor        # loads every declared extension entry
```

Inside a session, `/dsh-router-status` reports the router state.

Upgrade later:

```bash
omp plugin upgrade omp-ext-camellia
```

Uninstall:

```bash
omp plugin uninstall omp-ext-camellia
```

### Private-repo note

If this repository is private, the target machine needs git credentials before
`omp plugin install` can clone it (installation runs `bun install <git spec>`):

```bash
gh auth login          # then: gh auth setup-git
# or SSH: omp plugin install git@github.com:CamelliaV/omp-extensions.git
```

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
