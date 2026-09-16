# How to create Flamegraph

Run this in `src-tauri`:

```
WEBKIT_DISABLE_DMABUF_RENDERER=1 CARGO_PROFILE_RELEASE_DEBUG=true cargo flamegraph --release
```

You can leave out `WEBKIT_DISABLE_DMABUF_RENDERER=1` if you're not on NVIDIA/Linux

And then run this in the root dir:

```
yarn dev --port 1432
```

And then do what you want, and it'll create the flamegraph for you

# Frontend asset builds

The webview loads assets from `desktop/.output/` (`frontendDist` in
`tauri.conf.json`). Plain `cargo build -p drop-app` does **not** build the
frontend, so running such a binary builds shows a white
"Could not connect to localhost" screen. Build the UI first:

```sh
pnpm -C desktop/main install
pnpm -C desktop run build
```

# NVIDIA + Wayland startup crash

WebKitGTK's DMABUF renderer aborts with `Error 71 (Protocol error) dispatching
to Wayland display` on NVIDIA + Wayland sessions. Since the client is
unusable in that configuration, `src-tauri/src/main.rs` sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically before GTK initialization
when it detects an NVIDIA driver on a Wayland session, and only when the
variable isn't already set in the environment (so it can always be overridden).

# Tray icon libraries

On Linux the system tray uses the AppIndicator protocol via
`libayatana-appindicator`, which prints a deprecation warning. It is harmless;
once `libayatana-appindicator-glib` is preferred upstream, the client can
migrate.
