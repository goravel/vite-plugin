# Changelog

Notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Initial release.

- `goravel()` plugin for Vite 7 and 8: builds into the directory the framework's `vite` template function reads, with the manifest it resolves entries through. A `build.outDir`, `build.manifest` or bundler `input` of your own is taken as given, and the plugin warns where that leaves the application reading a build or a manifest that is not there.
- Discovery: the entry points, assets and paths come from the application through `artisan vite:inputs`, so `config/vite.go` is the only place they are set. `discoverCommand`, `discoverTimeout`, `discovered` and `discover: false` cover builds that run Artisan differently or not at all.
- Dev server: writes its URL to the hot file (a hot file it cannot write is reported rather than thrown, and quitting does not delete a hot file another server has since written), replaces the placeholder origin in served code once the URL is known (files Vite warms up before it listens wait for it, and in middleware mode the URLs stay relative to the page unless `server.origin` names one), refuses to start in CI unless `GORAVEL_BYPASS_ENV_CHECK` is set, and reads `APP_URL`, `ASSET_URL` and `VITE_DEV_SERVER_*` from the environment. The hot file carries the address browsers reach: a wildcard or IPv6 loopback bind is handed out as `localhost` (with a word on what other devices on the network need), an IPv6 host is bracketed, and a `server.origin` of your own decides the URL, trimmed of its trailing slash and refused unless it is an http(s) URL. It answers every origin unless `server.cors` says otherwise, so fonts and modules load from it wherever the application is served from.
- `refresh` reloads the page when views, language files or routes change, through vite-plugin-full-reload.
- `assets` builds and versions files nothing imports, such as the images `viteAsset` refers to.
- `@` resolves to `resources/js`.
