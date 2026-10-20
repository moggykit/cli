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

  Sponsor  https://associacaoambientaldaviadaestrela.org/en/cats/midge-2026-07
  Photo    https://moggy.dev/600/400/midge-2026-07
```

## Usage

```sh
npx moggykit                    # a cat, chosen at random
npx moggykit midge-2026-07      # a particular cat
npx moggykit --json             # raw JSON, for piping
npx moggykit browse             # interactive cat browser
```

| Option | Effect |
|---|---|
| `--json` | Print the API response instead of the pretty version |
| `--no-color` | Plain text, no ANSI colour (`NO_COLOR` is respected too) |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show the installed version |

### Interactive browser

Requires Node 20+ and an interactive terminal (both input and output). Use left/right
arrows to browse, `s` to open the selected cat's API-provided sponsorship URL in
your default browser, and `q` or Ctrl+C to quit. Navigation wraps at either end.

The browser loads every page of `/api/cats` and shows one name and story at a time.
Loading, an empty list and request failures appear in the browser; `q` still exits.
API text is stripped of terminal control sequences before display. Photos can be
attached to /dev/null posts; they are not rendered in the terminal. In pipes, redirected output or `TERM=dumb`, `browse` prints a
short explanation and exits without fetching or enabling keyboard controls.
`--no-color` disables colour; the browser still uses cursor controls to redraw.

#### Share a cat to /dev/null

Press `p` to prepare a post with the selected cat's name, public story,
sponsorship URL and photo. Preparation downloads the public photo and checks
your local SSH agent; it sends nothing to /dev/null.

The preview shows the full text, attachment type/size/source and signing-key
fingerprint. Press `v` to open the photo’s source URL in your default browser,
then return to the terminal preview. Viewing the photo does not publish anything.
Press `e` to edit: type at the end, use Backspace to delete, Ctrl+U
to clear, Enter for a newline, and Ctrl+D to return to the preview. Esc discards
edits or cancels a preview. When you finish editing, a missing sponsorship link
is restored in the preview, including its tracking parameters. Review the complete
text between the `---` lines; attachment and signing-key details are shown
separately and are not part of the post. Press `y` **from the preview** to confirm publishing
to your account. `q` exits, and Ctrl+C exits from any view. In the editor, `q` is
ordinary text.

Setup is required once:

1. Sign in to [dev-null.sh](https://dev-null.sh/) with GitHub.
2. Ensure an Ed25519 or RSA **authentication** public SSH key is on that GitHub
   account (GitHub Settings → SSH and GPG keys).
3. Load the matching private key into your local SSH agent, for example:

   ```sh
   ssh-add ~/.ssh/id_ed25519
   ```

4. MoggyKit defaults to `~/.ssh/id_ed25519.pub`. To choose another public key:

   ```sh
   MOGGYKIT_DEVNULL_KEY="$HOME/.ssh/your-key.pub" node bin/moggykit.js browse
   ```

OpenSSH's `ssh-keygen` (with SSH signing support) and `ssh-add` must be installed.
MoggyKit signs through the agent; it never reads your private key. Your signature
identifies the /dev/null account associated with that public key on GitHub. Check
the fingerprint in the preview before confirming. Nothing is posted automatically.

The image is fetched from the API's `photo_url`, held in memory and attached as
JPEG, PNG or WebP (up to 10 MB). Missing or invalid photos stop preparation.
/dev/null also checks image dimensions (up to 6000 × 6000) and post length; its
validation errors are shown. Temporary signing files are removed after signing,
including on cancellation. Photo bytes are discarded when the draft closes.

After submission, the returned link and any pending-review status appear in the
browser. MoggyKit attempts each cat only once per browser session and never
retries automatically. If a request times out or you quit during submission, the
post may have arrived: check your /dev/null profile before starting another
session to try again. Signing/authentication failures also require a new session.
Duplicate protection does not persist across sessions or other running browsers.

This uses /dev/null's existing [terminal posting protocol](https://github.com/nunomaduro/dev-null.sh/blob/production/resources/scripts/commit.sh),
including signing the image hash. It adds no dependencies. No /dev/null account
or SSH setup is needed for ordinary browsing or opening sponsorship pages.

To try an unpublished checkout locally, from the package directory:

```sh
node bin/moggykit.js browse
npm test
```

Sponsorship links use `associacaoambientaldaviadaestrela.org`. Legacy API links
using the previous association domain are converted while preserving their cat
paths and tracking parameters. This also applies to JSON output and /dev/null drafts.

The existing `MOGGYKIT_API` environment variable can point at another MoggyKit API
base URL (including `/api`) when developing.

## What this is

A small client for [moggy.dev](https://moggy.dev), with optional sharing to /dev/null. Cat data is fetched fresh for each session. Zero dependencies, because `npx` makes every user pay the install cost every time.

Moggykit is a set of free developer tools built from real rescue-cat data: placeholder images, a practice REST API, README widgets.

```html
<img src="https://moggy.dev/400/300">          <!-- random -->
<img src="https://moggy.dev/400/300/midge-2026-07">   <!-- a specific cat -->
```

## The cats are real

Every cat here lives with [Associação Ambiental da Via da Estrela](https://associacaoambientaldaviadaestrela.org) in Portugal, and every one of them can be sponsored. The tools are free forever; the hope is that somewhere between grabbing a placeholder and shipping your project, one of them catches your eye.

## Licence

MIT
