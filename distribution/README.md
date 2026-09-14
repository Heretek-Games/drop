# Distribution packaging

Packaging assets for every desktop-client distribution channel.

| Channel                        | Workflow (job)                                 | Trigger                                  | Package version                     |
| :----------------------------- | :--------------------------------------------- | :--------------------------------------- | :---------------------------------- |
| GitHub release (deb/rpm/…)     | `client-release.yml` (`publish-tauri`)         | release published / manual on a `v*` tag | `X.Y.Z`                             |
| Ubuntu PPA (stable)            | `client-release.yml` (`ppa-stable`)            | release published / manual on a `v*` tag | `X.Y.Z-1~ubuntu<jammy-noble>.1`     |
| Fedora COPR (stable)           | `client-release.yml` (`copr-stable`)           | release published / manual on a `v*` tag | `X.Y.Z-1`                           |
| GitHub rolling `alpha` release | `client-alpha.yml` (`build-and-publish-alpha`) | every push to `develop`                  | `X.Y.Z-alpha.<run>.<sha>`           |
| Ubuntu PPA (alpha)             | `client-alpha.yml` (`ppa-alpha`)               | every push to `develop`                  | `X.Y.Z~alpha.<run>+<sha>-0~ubuntu…` |
| Fedora COPR (alpha)            | `client-alpha.yml` (`copr-alpha`)              | every push to `develop`                  | `X.Y.Z~alpha.<run>+<sha>-1`         |

Stable is published **manually** (publish a GitHub release, or run the workflow
on a `v*` tag). Alpha publishes automatically on every qualifying commit to
`develop`. Target platforms are amd64, Ubuntu 22.04 (jammy) + 24.04 (noble) and
Fedora 41/42/rawhide.

## Application identifier

The Tauri identifier `org.droposs.client` is the single reverse-DNS identifier
for the client; the alpha channel uses `org.droposs.client.Alpha`. All packaged
`.desktop` entries, AppStream metadata and Flatpak manifests use these IDs so
package managers, AppStream and Flatpak agree on the application identity.

## Ubuntu PPA

Templates live in `distribution/debian/`. `scripts/distro/prepare-ppa-source.sh`
wraps the prebuilt `drop-app` binary from the CI `.deb` in a source tarball plus
a generated `debian/` directory; the
[`yuezk/publish-ppa-package`](https://github.com/yuezk/publish-ppa-package)
action (pinned by SHA in the workflows) then signs and uploads the source
package, and Launchpad builds the binary packages.

- Stable PPA: `ppa:heretek-games/drop`
- Alpha PPA: `ppa:heretek-games/drop-alpha`
- Series: jammy (22.04) and noble (24.04), amd64

Launchpad requires a unique source version per series, so the action suffixes
each upload with `{REVISION}~ubuntu<SERIES_VERSION>.1` (stable revision `1`,
alpha revision `0`). Alpha upstream versions use `~` (e.g.
`0.4.0~alpha.42+abc1234`) so they sort below `0.4.0` and `apt upgrade` moves
testers onto stable cleanly.

### One-time setup

1. Create a Launchpad **team** (e.g. `heretek-games`) and add the uploader
   (`~germproof471`); create PPAs `drop` and `drop-alpha` under it.
2. Create a dedicated GPG signing key, register its **public** key on the
   uploader's Launchpad account, and make the uploader a team member with
   upload rights.
3. Add repository secrets:
   - `PPA_GPG_PRIVATE_KEY` — ASCII-armored private key. The action runs
     `gpg --import` on it verbatim, so this must **not** be base64:
     `gpg --armor --export-secret-keys <KEYID>`
   - `PPA_GPG_PASSPHRASE` — key passphrase (omit for an unprotected key)
4. Add repository variables (`owner/archive` format):
   - `PPA_STABLE` = `heretek-games/drop`
   - `PPA_ALPHA` = `heretek-games/drop-alpha`

The action derives the signing key ID from the imported key and uploads over
Launchpad's anonymous FTP endpoint, authenticated by the GPG signature on the
`.changes` file.

## Fedora COPR

`distribution/rpm/drop-desktop-client.spec` packages the same prebuilt binary.
`scripts/distro/build-rpm-srpm.sh` assembles the source tarball and builds an
SRPM inside a Fedora container, then `copr-cli` submits it.

- Stable project: `heretek-ai/drop`
- Alpha project: `heretek-ai/drop-alpha`
- Chroots: `fedora-43-x86_64`, `fedora-44-x86_64`, `fedora-45-x86_64`

The channel is baked into the SRPM by flipping the spec's `%bcond_with alpha`
to `%bcond_without alpha`; command-line `--with` flags are not persisted in an
SRPM.

### One-time setup

1. Create the COPR projects under the `heretek-ai` owner
   (<https://copr.fedorainfracloud.org/coprs/heretek-ai/drop/>) and enable the
   chroots above.
2. Generate an API token at <https://copr.fedorainfracloud.org/api/> and copy
   the resulting `~/.config/copr` contents.
3. Add repository secret `COPR_API_TOKEN_CONFIG` — base64 of that file:
   `base64 -w0 ~/.config/copr`.
4. Add repository variables:
   - `COPR_STABLE` = `heretek-ai/drop`
   - `COPR_ALPHA` = `heretek-ai/drop-alpha`

## WinGet

WinGet publishing is automated: `.github/workflows/client-release.yml` runs
[`vedantmgoyal2009/winget-releaser`](https://github.com/vedantmgoyal2009/winget-releaser)
on tags/releases, which computes the installer SHA-256 from the release asset
and opens the pull request against `microsoft/winget-pkgs`.

Do **not** commit hand-written manifests here with placeholder hashes — an
`InstallerSha256` of all zeroes is invalid and will fail validation. The
previous `distribution/winget/` tree was removed for that reason; add the
package to WinGet by tagging a release (or with `wingetcreate` against the
published asset) instead.

## Flatpak

`flatpak/` contains the manifest, AppStream metadata and desktop entry for the
desktop client (`org.droposs.client`) and the alpha channel
(`org.droposs.client.Alpha`).

Permission notes (review before submitting to Flathub):

- `--filesystem=host:ro` gives the sandbox read access to the host filesystem
  so games installed anywhere can be launched.
- `--talk-name=org.freedesktop.Flatpak` (plus `--device=all`) lets the app
  spawn host tools (Proton/Steam runtimes, controllers). Combined with the
  host mount this is a broad sandbox escape and must be documented in the
  Flathub submission.
- `--share=network` covers server sync, downloads and the GSE mesh.

For a stricter build, replace the host mount with explicit game directories
and drop the `org.freedesktop.Flatpak` talk-name (at the cost of launching
host-installed games).
