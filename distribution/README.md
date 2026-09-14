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

Templates live in `distribution/debian/`. `scripts/distro/build-deb-source.sh`
wraps the prebuilt `drop-app` binary from the CI `.deb` in a Debian source tree
and signs the `.dsc`/`.changes`; `dput` then uploads them to Launchpad, which
builds the actual binary packages.

- Stable PPA: `ppa:heretek-games/drop`
- Alpha PPA: `ppa:heretek-games/drop-alpha`

Launchpad requires a unique source version per series, so each upload is
suffixed `~ubuntu22.04.1` / `~ubuntu24.04.1`. Alpha upstream versions use `~`
(e.g. `0.4.0~alpha.42+abc1234`) so they sort below `0.4.0` and `apt upgrade`
moves testers onto stable cleanly.

### One-time setup

1. Create a Launchpad account and PPAs named `drop` and `drop-alpha` under the
   `heretek-games` team (or your own user).
2. Create a dedicated GPG signing key and register its **public** key on
   Launchpad (Account → OpenPGP keys).
3. Add repository secrets:
   - `PPA_GPG_PRIVATE_KEY` — base64 of the ASCII-armored private key:
     `gpg --export-secret-keys --armor <KEYID> | base64 -w0`
   - `PPA_GPG_KEY_ID` — full fingerprint or key ID
   - `PPA_GPG_PASSPHRASE` — key passphrase (omit for an unprotected key)
4. Add repository variables:
   - `PPA_STABLE` = `ppa:heretek-games/drop`
   - `PPA_ALPHA` = `ppa:heretek-games/drop-alpha`

Uploads use Launchpad's anonymous FTP endpoint and are authenticated by the GPG
signature on the `.changes` file. `scripts/distro/setup-gpg.sh` imports the key
and presets the passphrase for non-interactive `debsign`. Local dry runs can use
`build-deb-source.sh --no-sign` (which passes `-us -uc`).

## Fedora COPR

`distribution/rpm/drop-desktop-client.spec` packages the same prebuilt binary.
`scripts/distro/build-rpm-srpm.sh` assembles the source tarball and builds an
SRPM inside a Fedora container, then `copr-cli` submits it.

- Stable project: `heretek-games/drop`
- Alpha project: `heretek-games/drop-alpha`
- Chroots: `fedora-41-x86_64`, `fedora-42-x86_64`, `fedora-rawhide-x86_64`

The channel is baked into the SRPM by flipping the spec's `%bcond_with alpha`
to `%bcond_without alpha`; command-line `--with` flags are not persisted in an
SRPM.

### One-time setup

1. Create the COPR projects and enable the chroots above.
2. Generate an API token at <https://copr.fedorainfracloud.org/api/> and copy
   the resulting `~/.config/copr` contents.
3. Add repository secret `COPR_API_TOKEN_CONFIG` — base64 of that file:
   `base64 -w0 ~/.config/copr`.
4. Add repository variables:
   - `COPR_STABLE` = `heretek-games/drop`
   - `COPR_ALPHA` = `heretek-games/drop-alpha`

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
