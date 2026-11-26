# Host Authentication Setup (`work-v2`)

The `work-v2` plugin synchronizes repositories securely with Supabase. It stores the authentication refresh token in a local OS-protected vault using Windows Data Protection API (DPAPI).

## Prerequisites & Security Guarantees

1. **Same Windows User Account**:
   DPAPI encrypts credentials with `DataProtectionScope::CurrentUser`, locked to the local Windows user identity (SID) and ACL-restricted under `%LOCALAPPDATA%\DSH-Work\`. The DSH Host process must run under the **exact same Windows account** that executed the login CLI. If DSH runs as a Windows service or scheduled task under another account (e.g. `SYSTEM` or another user), it cannot decrypt the token.
2. **No Secret / Service-Role Key**:
   Only configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or public anon key). **Never** supply Supabase `service-role` or `sb_secret_` keys on the Host or in repository files.
3. **Fail-Closed Protection**:
   Secure credential storage is enforced: if executed on a non-Windows environment or if the DPAPI vault fails, authentication fails closed without printing, logging, or storing plaintext tokens.
4. **No Command-Line Secrets**:
   Passing passwords or tokens via CLI arguments (`argv`) is prohibited to prevent exposure in process trees, logs, and shell histories.

---

## Authentication Commands

Navigate to `plugins/work-v2/` in an interactive PowerShell or terminal:

### 1. Log In (Interactive Hidden Prompt)

Set the required environment variables in your terminal session:

```powershell
$env:SUPABASE_URL = "https://<your-project-ref>.supabase.co"
$env:SUPABASE_PUBLISHABLE_KEY = "<your-publishable-or-anon-key>"
node login.js login
```

- Prompts interactively for **Email** and **Password** (password input is muted/hidden on the TTY).
- Authenticates against Supabase Auth (`/auth/v1/token?grant_type=password`).
- Atomically encrypts and writes the refresh token via DPAPI to `%LOCALAPPDATA%\DSH-Work\refresh-token.dpapi`.
- Never prints or logs the refresh or access tokens.

### 2. Check Authentication Status

```powershell
node login.js status
```

Reports whether an encrypted refresh token exists in the DPAPI vault without disclosing any token material.

### 3. Log Out

```powershell
node login.js logout
```

Securely removes the encrypted token file from the DPAPI vault.

---

## Applying to DSH Host

After logging in or modifying credentials, **restart the DSH Host process**:
- Refreshing the web browser GUI reloads client assets only; it does not reload Host backend plugins or re-initialize Host session state.
- Once restarted, `work-v2` reads the DPAPI-stored token to exchange and rotate access sessions for repository synchronization.
