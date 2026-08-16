# Publication repository policy

This repository owns a backend-first Windforce App for publishing Markdown to
multiple platforms. Tistory is the first provider.

- Keep provider-neutral actions and domain types separate from Tistory's
  undocumented admin HTTP adapter.
- Use a visible browser only for interactive login. After login, metadata,
  media, publish, update, and delete operations use direct HTTP requests.
- Never place passwords, cookies, Playwright storage state, or session values in
  action outputs, Resources, logs, fixtures, or Git. Raw session state belongs
  only in an App-owned Secret Variable.
- App Resources contain non-secret connection metadata and a `$var@app:`
  reference to the Secret Variable.
- Do not persist post drafts in Windforce runtime configuration. Draft inputs
  stay stateless until a dedicated content store is deliberately introduced.
- Public publishing and destructive post operations require HumanTask approval.
- The React UI is a later phase. Do not add UI code until the backend contract is
  complete and explicitly approved.
- Treat Tistory admin endpoints as a versioned, tested adapter contract because
  they are private and may change without notice.
