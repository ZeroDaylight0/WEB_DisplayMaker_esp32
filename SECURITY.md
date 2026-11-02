# Security Policy

## Supported versions

Only the latest release on `main` receives fixes.

## Notes

- The bundled Node server (`server.mjs`) is meant for local or LAN use.
  Do not expose it to the internet without a reverse proxy and authentication.
- Example sketches read Wi-Fi and MQTT credentials from `secrets.h`.
  Copy `secrets.example.h` to `secrets.h` and never commit the real file.

## Reporting a vulnerability

Please do **not** open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/ZeroDaylight0/WEB_DisplayMaker_esp32/security/advisories/new)
with steps to reproduce.
