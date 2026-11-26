# Live connection and RLS verification

Run only against the intended Supabase project. The verifier creates a uniquely named test object and `work_repos` row, then removes them. Use two disposable test users and their refresh tokens; never paste tokens into this document, source control, or chat. Output reports checks only and does not print tokens.

## Setup

On each machine, run `npm install --prefix scripts/work` to install the verifier's local dependency. Copy the template (`docs/work/.env.example`) into a private local file or set these variables in your shell: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OWNER_REFRESH_TOKEN`, and `OTHER_REFRESH_TOKEN`. Use the project URL and publishable (or legacy anon public) key from the Supabase dashboard. Do not use a service-role/secret key. Refresh tokens are private credentials; protect them. Supabase refresh-token rotation issues replacement refresh tokens during `refreshSession`; the script intentionally does not print or persist replacements. After the run, the supplied environment refresh tokens may be stale: update them from a trusted credential/session source before any rerun, and never reuse stale values.

Preferred interactive method (no need to obtain or store refresh tokens manually): set only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in a separate terminal, then run `node scripts/work/verify-with-passwords.js`. It prompts for each disposable user's email and hidden password, signs in locally, passes the temporary refresh tokens to the child verifier, and exits without saving or displaying them. Do not run this in a terminal with session recording or keylogging.

Alternatively, if you already have fresh refresh tokens in a secure local environment, run:

```sh
node scripts/work/verify-connection.js
```

Each line reports `PASS` or `FAIL`; a failure exits nonzero. Cross-user checks run only after owner upload and metadata insertion succeed. Test coverage includes owner upload/download and metadata insert/read, second-user inability to read/update/delete the owner's row, upload into the owner's prefix, or download its object, and anonymous denial for table read and storage upload/download. The script uses `auth.refreshSession({ refresh_token })` with no other session fields.

If any check fails, confirm the migration in `01_work_repos_phase1.sql` is applied, the bucket is private, both refresh tokens are valid, and the owner/other credentials belong to distinct users. Cleanup is attempted in a `finally` block; if cleanup itself reports `FAIL`, remove only the uniquely named `verify-*` test row/object after checking the project and owner prefix.
