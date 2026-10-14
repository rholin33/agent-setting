---
name: runtime-config
description: Use when a frontend project needs selected .env values moved into deployment-time runtime-config.js, especially for Vite, Vue CLI, React, or Vue apps; use when build-time env values must be editable after build, while excluding secrets, keys, tokens, passwords, and credentials.
---

# Runtime Config

## Overview

Convert safe frontend build-time environment values into a runtime-loaded `runtime-config.js` file. The runtime file must be deploy-editable, loaded before the app entry bundle, and limited to non-sensitive values.

## Safety Rule

Never map sensitive values to `runtime-config.js`. Treat these names as sensitive by default:

`secret`, `key`, `token`, `password`, `passwd`, `pwd`, `credential`, `private`, `cert`, `signature`, `client_secret`, `access_key`, `refresh_token`, `api_key`

If a variable name is ambiguous, ask before exposing it. Public URLs, feature flags, app titles, tenant IDs, and service base paths are usually safe; authentication secrets are not.

## Workflow

1. Identify the frontend stack and entry HTML:
   - Vite: `index.html`, public files copied from `public/`.
   - Vue CLI: `public/index.html`, public files copied from `public/`.
   - React apps vary; follow the project's existing public/static convention.

2. Inventory env files and actual usages:
   - Read `.env*` files.
   - Search for `import.meta.env`, `process.env`, `VITE_`, `VUE_APP_`, `REACT_APP_`, and hard-coded service URLs.
   - Keep only variables that are both safe and relevant to the request.

3. Propose the exact runtime keys before broad changes:
   - Runtime keys should normally match existing env names when the project already uses framework-prefixed names, e.g. `VUE_APP_RA_API`.
   - Do not invent generic keys such as `apiBaseUrl`, `clientId`, or `authServer` unless those concepts already exist or the user requested them.

4. Add `public/runtime-config.js`:

```js
window.RUNTIME_CONFIG = {
  VUE_APP_RA_ADDRESS: '',
  VUE_APP_RA_API: ''
}
```

5. Load it before the app bundle:
   - Vite: add `<script src="/runtime-config.js"></script>` before `<script type="module" src="/src/main...">`.
   - Vue CLI: add `<script src="<%= BASE_URL %>runtime-config.js"></script>` before injected built files or before the first app script.

6. Add a small config module, for example `src/config/runtime.js`:

```js
const value = (runtimeConfig, env, key) => {
  const runtimeValue = runtimeConfig[key]
  return runtimeValue !== undefined && runtimeValue !== null && runtimeValue !== ''
    ? runtimeValue
    : env[key] || ''
}

export function resolveRuntimeConfig(runtimeConfig = {}, env = {}) {
  return {
    RA_ADDRESS: value(runtimeConfig, env, 'VUE_APP_RA_ADDRESS'),
    RA_API: value(runtimeConfig, env, 'VUE_APP_RA_API')
  }
}

export const runtimeConfig = typeof window !== 'undefined' ? window.RUNTIME_CONFIG || {} : {}
const resolved = resolveRuntimeConfig(runtimeConfig, process.env || {})

export const RA_ADDRESS = resolved.RA_ADDRESS
export const RA_API = resolved.RA_API
```

For Vite, use `import.meta.env || {}` instead of `process.env || {}`.

7. Replace business reads:
   - Import from the config module.
   - Replace direct safe env reads in runtime code, e.g. `process.env.VUE_APP_RA_API` -> `RA_API`.
   - Leave sensitive env reads in build-time/server-side-only code untouched.

8. Test and verify:
   - Add a focused test for runtime-priority and env-fallback behavior when the repo has a simple JS test path.
   - Run the project build.
   - Confirm the built output contains `runtime-config.js` at the deployed root and the built HTML references it.

## Common Mistakes

- Mapping every `.env` variable instead of only safe, needed values.
- Renaming existing env keys unnecessarily, which makes deployment confusing.
- Loading `runtime-config.js` after the bundle, so the app reads fallback values.
- Putting secrets in `runtime-config.js`; it is public browser-readable JavaScript.
- Assuming Vite patterns apply unchanged to Vue CLI or Create React App. Check the entry HTML and env API first.
