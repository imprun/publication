# Publication core

- Backend-first Windforce App; React UI is deferred until explicit approval.
- Provider-neutral actions dispatch to isolated adapters; Tistory is the first provider.
- Login alone uses visible Playwright plus HumanTask. All post-login metadata, media, and post lifecycle operations use direct HTTP.
- Raw session state belongs at App Secret Variable `connections/tistory/default/session`; safe connection metadata belongs at App Resource `connections/tistory/default/profile` with a `$var@app:` reference.
- Drafts are stateless. `post.prepare` returns a hash; runtime configuration is not a draft database.
- Read provider details in `mem:backend/tistory`; toolchain in `mem:tech_stack`; completion gates in `mem:task_completion`.