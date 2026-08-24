# moggykit

Real rescue cats in your terminal.

```sh
npx moggykit
```

```
   /\_/\    Midge
  ( o.o )   male · ~10m · active
   > ^ <

  Found under a wheelbarrow.

  Sponsor  https://aave.pt/en/cats/midge-2026-07
  Photo    https://moggy.dev/600/400/midge-2026-07
```

## Usage

```sh
npx moggykit                    # a cat, chosen at random
npx moggykit midge-2026-07      # a particular cat
npx moggykit --json             # raw JSON, for piping
```

| Option | Effect |
|---|---|
| `--json` | Print the API response instead of the pretty version |
| `--no-color` | Plain text, no ANSI colour (`NO_COLOR` is respected too) |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show the installed version |

## What this is

A thin client for [moggy.dev](https://moggy.dev) — no caching, no cleverness, no logic of its own. Zero dependencies, because `npx` makes every user pay the install cost every time.

Moggykit is a set of free developer tools built from real rescue-cat data: placeholder images, a practice REST API, README widgets.

```html
<img src="https://moggy.dev/400/300">          <!-- random -->
<img src="https://moggy.dev/400/300/midge-2026-07">   <!-- a specific cat -->
```

## The cats are real

Every cat here lives with [Associação Ambiental da Via da Estrela](https://aave.pt) in Portugal, and every one of them can be sponsored. The tools are free forever; the hope is that somewhere between grabbing a placeholder and shipping your project, one of them catches your eye.

## Licence

MIT
