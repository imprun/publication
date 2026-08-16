# Conventions

- Keep action inputs/outputs Zod-validated and mirrored by JSON Schema.
- Never log or return credentials, cookies, storageState, sessionStorage, or resolved Secret Resource fields.
- Permit only normalized direct `*.tistory.com` hosts and `/manage/` adapter paths.
- Public publish, private publish, update, and delete require HumanTask approval; verify draftHash before approval or network mutation.
- Keep exact App-scoped runtimeAccess paths; only `connection.login` receives write access.
- Do not add a database, dynamic connection paths, or frontend code without an explicit architecture change.
- Preserve provider-specific Markdown/attachment rules inside `src/providers/tistory`.