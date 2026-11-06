# goravel-vite-plugin

[![npm version](https://img.shields.io/npm/v/goravel-vite-plugin.svg)](https://www.npmjs.com/package/goravel-vite-plugin)
[![tests](https://github.com/goravel/vite-plugin/actions/workflows/tests.yml/badge.svg)](https://github.com/goravel/vite-plugin/actions/workflows/tests.yml)
[![license](https://img.shields.io/npm/l/goravel-vite-plugin.svg)](LICENSE)

Vite plugin for [Goravel](https://www.goravel.dev) applications. It is the counterpart of the framework's `vite` template function: the plugin builds your assets where the framework looks for them, and while the dev server runs it tells the framework where to find it.

- `vite build` writes to `public/build` with a `.vite/manifest.json` the framework resolves entry points through.
- The entry points are discovered from your views: whatever `{{ vite ... }}` and `{{ viteAsset ... }}` ask for is built, so the list is not kept twice.
- The paths are the framework's: the plugin asks the application where it reads the build and the hot file, so `config/vite.go` is the only place they are set.
- `vite` (the dev server) writes its URL to `public/hot`; as long as that file exists, `{{ vite ... }}` points every tag at the dev server and you get hot module replacement.
- The dev server answers every origin, so the fonts, images and modules a page loads from it are not blocked wherever the application is served from. Set `server.cors` yourself to narrow it.
- With `refresh: true`, the page reloads when a view, language or route file changes.
- `@` resolves to `resources/js`.

## Requirements

- Node 20.19+ or 22.12+
- Vite 7 or 8
- Goravel with the `Vite` service provider installed: `./artisan package:install Vite`

## Installation

```bash
npm install --save-dev vite goravel-vite-plugin
```

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import goravel from 'goravel-vite-plugin';

export default defineConfig({
    plugins: [
        goravel({
            refresh: true,
        }),
    ],
});
```

`package.json`:

```json
{
    "scripts": {
        "dev": "vite",
        "build": "vite build"
    }
}
```

Then load the entries from a view:

```html
<head>
    {{ vite "resources/css/app.css" "resources/js/app.js" }}
</head>
```

The plugin asks the application where to build and which entries the views reference (see [Discovery](#discovery)), so nothing has to be listed in `vite.config.js`. Run `npm run dev` next to your Go server while developing, and `npm run build` before deploying. The built files are plain static files under `public/build`; serve them like the rest of `public/`, for example with `facades.Route().Static("build", path.Public("build"))`.

## Options

`goravel()` takes a single entry point, a list of them, or a configuration object. Everything is optional:

| Option | Default | |
| --- | --- | --- |
| `input` | | Entry points to build, relative to the project root, in addition to the discovered ones. Required when `discover` is `false` |
| `discover` | `true` | Ask the application for its paths and for the entry points and assets the views reference. A build builds them too; the dev server only takes the paths |
| `discoverCommand` | `['go', 'run', '.', 'artisan', 'vite:inputs']` | The command that prints them, run in the project root (Vite's `root`). A string is split on whitespace |
| `discoverTimeout` | `300000` | How long to wait for the command, in milliseconds. `go run` compiles the application first, which takes a while on a cold cache |
| `discovered` | | The output of `artisan vite:inputs`, for builds that cannot run the application. The command is then not run |
| `publicDirectory` | what the application reports, else `'public'` | The directory the application serves as its web root. Set it only to override the application |
| `buildDirectory` | what the application reports, else `'build'` | The subdirectory of the public directory the build is written to. Set it only to override `vite.build_directory` |
| `hotFile` | what the application reports, else `` `${publicDirectory}/hot` `` | Where the dev server announces its URL. Set it only to override `vite.hot_file` |
| `refresh` | `false` | `true` watches `resources/views/**`, `lang/**`, `resources/lang/**` and `routes/**` (those that exist). A string, a list of globs, or a [vite-plugin-full-reload](https://github.com/ElMassimo/vite-plugin-full-reload) configuration watches exactly that; the exported `refreshPaths` lists the four, for `refresh: [...refreshPaths, 'app/**']` |
| `assets` | `[]` | Globs of files to build and version although nothing imports them, in addition to the discovered `viteAsset` files |
| `transformOnServe` | | `(code, devServerUrl) => code`, applied to everything the dev server serves |

To move the build directory, the hot file or the manifest, edit `config/vite.go` and nothing else; the plugin reads the result:

```go
config.Add("vite", map[string]any{
    "build_directory": "assets",              // inside the public directory, default "build"
    "hot_file":        "storage/hot",         // relative to the project root, default "public/hot"
    "manifest":        ".vite/manifest.json", // inside the build directory
})
```

The `publicDirectory`, `buildDirectory` and `hotFile` options exist for the case where the plugin cannot ask, or has to disagree. Vite's own `build.manifest` and `build.outDir` win over everything, as usual, but the application reads only `config/vite.go`: a `build.outDir` of your own moves the build and its URLs, and a `build.manifest` of your own renames the manifest, and the plugin warns about either, because the framework keeps reading from `vite.build_directory` and `vite.manifest`. Set those instead. Likewise a `build.rollupOptions.input` (or `rolldownOptions.input` on Vite 8) of your own is built as written, and the plugin's `input` and the discovered entries are ignored; the plugin says so.

The command runs in Vite's `root`, which is the project root unless `vite.config.js` moves it, so the paths it reports and the entries it finds are relative to the same directory the framework uses.

## Discovery

Go parses every view when the application boots, and a `{{ vite "resources/js/app.js" }}` call survives in the parsed tree as a function call with string arguments. `artisan vite:inputs` compiles the view set the same way, collects the arguments of every `vite` and `viteAsset` call, including views that packages ship in an `embed.FS`, and prints them along with the paths of `config/vite.go`:

```bash
$ go run . artisan vite:inputs
{"inputs":["resources/css/app.css","resources/js/app.js"],"assets":["resources/images/logo.svg"],"dynamic":[],"paths":{"public_directory":"public","build_directory":"build","hot_file":"public/hot","manifest":".vite/manifest.json"}}
```

Both commands run it. A build merges the inputs with `input` and `assets` and builds the union where `paths` say; the dev server takes `paths` to know where to write the hot file, and serves whatever the page requests, so a new `{{ vite }}` call works without a restart. The plugin knows nothing else about the application: swap the command for a compiled binary (`discoverCommand: './main artisan vite:inputs'`), or run any program that prints the same JSON.

What it cannot see is a computed argument such as `{{ vite .entry }}`. Those calls are reported under `dynamic`, the plugin warns about them, and you add the entry to `input` yourself.

### Building without Go

Where the build runs without a Go toolchain, for example a Node-only Docker stage, save the command's output and hand it over:

```bash
go run . artisan vite:inputs > vite-inputs.json
```

```js
import { readFileSync } from 'node:fs';

goravel({ discovered: JSON.parse(readFileSync('vite-inputs.json', 'utf8')) })
```

Or turn discovery off and list the entries as before. The paths then fall back to the framework's defaults unless the options say otherwise:

```js
goravel({ input: ['resources/css/app.css', 'resources/js/app.js'], discover: false })
```

## Environment

The plugin reads your `.env` from Vite's `envDir`, so `envDir: false` leaves only the process environment:

| Variable | |
| --- | --- |
| `APP_URL` | Shown in the dev server banner and on the page the dev server serves when it is opened directly |
| `ASSET_URL` | Prefixes the build's `base`, for assets served from a CDN. Set `app.asset_url` in the framework to match |
| `VITE_DEV_SERVER_KEY`, `VITE_DEV_SERVER_CERT` | Serve the dev server over TLS with these files, relative to the project root. The host is taken from `APP_URL` |
| `CI` | The dev server refuses to start when this is set; set `GORAVEL_BYPASS_ENV_CHECK=1` to start it anyway |

## Other devices on the network

The hot file carries the address the plugin works out from the socket Vite bound. A wildcard bind (`server.host: true`) is handed out as `localhost`, which only works on this machine. For a phone or another machine, name the address they reach this machine at:

```js
export default defineConfig({
    server: {
        host: true,
        hmr: { host: '192.168.1.5' },
        // Only needed when the address above is a name rather than an IP
        allowedHosts: ['dev.example.test'],
    },
    plugins: [goravel({ refresh: true })],
})
```

To state the whole URL, behind a reverse proxy, a tunnel or an HTTPS terminator, set [`server.origin`](https://vite.dev/config/server-options#server-origin) instead. It wins over `server.hmr.host` and the bound address, and is what the hot file carries and what Vite writes into asset URLs, so both agree. It has to be an `http` or `https` URL; anything else is reported and ignored.

## Reloading

Go templates are parsed when the application boots, so a change to a `.tmpl` file reaches the browser only once the Go process has restarted. `refresh: true` is most useful next to a watcher such as [air](https://github.com/air-verse/air) that rebuilds the server for you: the reload then shows the restarted server's output.

## Template functions

The framework registers three functions for every view once the `Vite` provider is installed:

| Function | |
| --- | --- |
| `{{ vite "resources/js/app.js" }}` | The tags that load the entry points: stylesheets, module preloads and module scripts, or the dev server equivalents |
| `{{ viteAsset "resources/images/logo.svg" }}` | The URL of a built asset |
| `{{ viteReactRefresh }}` | The preamble `@vitejs/plugin-react` needs; empty outside the dev server |

## Development

```bash
pnpm install
pnpm test
```

The tests run a real Vite build and dev server in a temporary directory. Node stands in for Go, so no Go toolchain is needed to run them.

### Releasing

1. Bump `version` in `package.json` and move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under the new version.
2. Commit, tag `vX.Y.Z` and push the tag.
3. Run `pnpm publish`. It builds and runs the tests first.

## Contributing

Issues and pull requests are welcome at [goravel/vite-plugin](https://github.com/goravel/vite-plugin). The framework side of this integration lives in [goravel/framework](https://github.com/goravel/framework).

## License

MIT, see [LICENSE](LICENSE).
