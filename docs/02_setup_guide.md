# Work repository setup guide

The Phase 1 schema creates private bucket `work-repos` and `public.work_repos`, with owner-only RLS. See [01_work_repos_phase1.sql](01_work_repos_phase1.sql) for the authoritative schema and policies.

1. Create two disposable authentication users in Supabase (owner and other user).
2. Run `01_work_repos_phase1.sql` in the Supabase SQL Editor.
3. Copy the Project URL and publishable key (legacy anon public key is also accepted) into a local environment. Do not use a service-role key.
4. Use [receiver.env.example](receiver.env.example) on the DSH Host and [publisher.env.example](publisher.env.example) on machine 2. These are placeholders, not secret stores. Restart the existing DSH Host after changing its environment; a browser refresh alone does not reload Host JavaScript or environment variables.
5. Follow [03_live_verification.md](03_live_verification.md) for a separate two-user test environment and live RLS verification. The Work Settings default download directory is session-only in this version; reselect it after a Host restart.

The Work Host reads its environment at startup. If DSH is launched by a watchdog or service, setting variables only in a new PowerShell window does not change that launcher’s environment; configure the launcher securely outside the repository and restart the Host. Never put the Supabase service-role/`sb_secret_` key in the publisher, Work plugin settings, or a committed file. Rotate any key disclosed in chat.

The migration requires private bucket `work-repos`, owner UUID-prefixed immutable object paths, and table records with `owner_id`, `repo_name`, `machine_id`, `file_size`, `sha256`, and `storage_path`. Keep all credentials outside the repository; the `.env.example` templates contain placeholders only. On machine 2, install Node.js 22+ and run `npm install --prefix tools/work-publisher` once, then from the repository directory run `node <path-to-work-publisher>/cli.js preview` and `node <path-to-work-publisher>/cli.js publish`. `publish` authenticates interactively; standalone `login` cannot save a session without an OS-backed secret store. ZIPs over 50 MiB are rejected.
