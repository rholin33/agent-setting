# YAML parser

`yaml.mjs` bundles the browser ESM entry of `yaml@2.9.1` (ISC, Eemeli Aro); license in `yaml.LICENSE`.
Upstream: https://github.com/eemeli/yaml

Generated with `esbuild@0.28.2`:

```text
esbuild node_modules/yaml/browser/index.js --bundle --format=esm --platform=node --minify --outfile=yaml.mjs
```

The portable Orca team package is copied without npm installation. Vendoring this parser lets it read native OMP YAML without a Python/npm runtime dependency. Do not edit the generated bundle manually.
