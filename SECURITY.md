# Security policy

## Reporting a vulnerability

Please report security problems privately, not in public issues. Use this repository's **Security → Report a vulnerability** (GitHub private advisories), or contact the author through [xo.st](https://xo.st). Include steps to reproduce and the version (shown in the admin panel under About).

## Supported versions

Security fixes go into the latest release. Update with `docker compose pull && docker compose up -d` (or rebuild from source).

## Running Axdio safely

- Serve it over HTTPS behind a reverse proxy, then turn on **Security → Redirect HTTP to HTTPS**.
- Keep **Behind a reverse proxy** on only when a proxy really sits in front; otherwise visitors could fake their address.
- Use **Accounts & access → Sign-ups: invite code required** or **closed** on public servers, and consider **Private server**.
- Backups and the `config` folder contain password hashes, login token hashes, webhook URLs and the session key. Keep them private.
- Custom `<head>` HTML runs in every listener's browser. Only paste code you trust.
