# Spec file for the Drop Desktop Client (Fedora COPR)
# Supports both stable and alpha channels via `--with alpha`.
#
# The Tauri client is compiled in CI and shipped prebuilt in the source
# tarball produced by scripts/distro/build-rpm-srpm.sh, so this spec only
# installs files.

%bcond_with alpha

%{!?_pkg_version: %global _pkg_version 0.4.0}
%{!?_pkg_release: %global _pkg_release 1}
%{!?_metainfodir: %global _metainfodir %{_datadir}/metainfo}

%if %{with alpha}
%global pkg_name drop-desktop-client-alpha
%global bin_name drop-desktop-client-alpha
%global desktop_file org.droposs.client.Alpha.desktop
%global metainfo_file org.droposs.client.Alpha.metainfo.xml
%global icon_file org.droposs.client.Alpha.png
%global app_title Drop Desktop Client (Alpha Preview)
%else
%global pkg_name drop-desktop-client
%global bin_name drop-desktop-client
%global desktop_file org.droposs.client.desktop
%global metainfo_file org.droposs.client.metainfo.xml
%global icon_file org.droposs.client.png
%global app_title Drop Desktop Client
%endif

Name:           %{pkg_name}
Version:        %{_pkg_version}
Release:        %{_pkg_release}%{?dist}
Summary:        %{app_title}

License:        AGPL-3.0-only
URL:            https://github.com/Heretek-Games/drop
Source0:        %{pkg_name}-%{version}.tar.gz

ExclusiveArch:  x86_64

# Tauri v2 / WebKitGTK runtime dependencies on Fedora
Requires:       webkit2gtk4.1%{?_isa}
Requires:       gtk3%{?_isa}
Requires:       libayatana-appindicator-gtk3%{?_isa}
Requires:       librsvg2%{?_isa}
Requires:       xdg-utils

# Precompiled binary provided from CI release runner
%global debug_package %{nil}
%global __strip /bin/true

%description
Drop is an open-source, self-hosted game library and distribution platform.
This desktop client connects to your Drop server instance to download,
manage, update, and launch your games with native Proton/Wine and emulator support.
%if %{with alpha}
This package contains bleeding-edge alpha snapshot builds.
%endif

%prep
%autosetup -n %{pkg_name}-%{version}

%build
# Binary is pre-compiled by the GitHub Actions runner.
test -f drop-app

%install
rm -rf %{buildroot}
install -Dm755 drop-app %{buildroot}%{_bindir}/%{bin_name}
install -Dm644 %{desktop_file} %{buildroot}%{_datadir}/applications/%{desktop_file}
install -Dm644 %{metainfo_file} %{buildroot}%{_metainfodir}/%{metainfo_file}
install -Dm644 %{icon_file} %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/%{icon_file}

%files
%{_bindir}/%{bin_name}
%{_datadir}/applications/%{desktop_file}
%{_metainfodir}/%{metainfo_file}
%{_datadir}/icons/hicolor/512x512/apps/%{icon_file}

%changelog
* Sun Sep 13 2026 Heretek Games <contact@heretek.games> - %{version}-%{release}
- Automated build for Fedora Copr
