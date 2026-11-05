# Changelog

Notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Initial release.

- `goravel()` plugin for Vite 7 and 8: builds into the directory the framework's `vite` template function reads, with the manifest it resolves entries through.
- Discovery: the entry points, assets and paths come from the application through `artisan vite:inputs`, so `config/vite.go` is the only place they are set. `discoverCommand`, `discoverTimeout`, `discovered` and `discover: false` cover builds that run Artisan differently or not at all.
- Dev server: writes its URL to the hot file, replaces the placeholder origin in served code, refuses to start in CI unless `GORAVEL_BYPASS_ENV_CHECK` is set, and reads `APP_URL`, `ASSET_URL` and `VITE_DEV_SERVER_*` from the environment. It answers every origin unless `server.cors` says otherwise, so fonts and modules load from it wherever the application is served from.
- `refresh` reloads the page when views, language files or routes change, through vite-plugin-full-reload.
- `assets` builds and versions files nothing imports, such as the images `viteAsset` refers to.
- `@` resolves to `resources/js`.
