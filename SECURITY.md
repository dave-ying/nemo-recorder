# Security Policy

## Reporting a Vulnerability

Nemo Recorder is a client-side static web app — all audio processing happens in the browser. There is no backend, database, authentication, or server-side code in this repository.

If you find a security issue, please **do not** open a public GitHub issue. Instead, report it privately:

- Open a private vulnerability report via GitHub's **Security** tab → **Report a vulnerability**, or
- Email the maintainer at the address listed on the GitHub profile.

Please include:
- A clear description of the issue and its impact
- Steps to reproduce (HTML/JS snippet, browser + version, OS)
- Any suggested fix

You'll get an acknowledgment within a few days. Responsible disclosure is appreciated — we'll credit you in the fix commit if you'd like.

## Scope

In scope:
- This repository's code (`js/`, `dev-server.js`, `index.html`, `styles.css`, tests, vendored libraries as used here)
- The published static site as served from the default branch

Out of scope:
- `dev-server.js` is a minimal local-only dev server and is **not** intended for production hosting. Issues that only manifest when exposing it to the public internet are out of scope — use any static host instead.
- Vulnerabilities in upstream dependencies (lamejs, rnnoise-wasm) should be reported to those projects directly; we will track and update vendored copies when fixes are available.

## Supported Versions

Only the latest release line receives security updates.
