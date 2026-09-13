# Distribution packaging

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
desktop client.

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
