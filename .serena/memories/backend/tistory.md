# Tistory adapter

- Admin HTTP contract is private/undocumented and must fail closed on redirects, 401/403, login HTML, invalid JSON, or unexpected entry URLs.
- Endpoints: categories GET `/manage/category.json`; media POST `/manage/post/attach.json`; create POST `/manage/post.json`; update PUT `/manage/post/{id}.json`; delete DELETE same path.
- Visibility integers: private 0, public 20. Never use POST for update because it creates another post.
- Tistory stores rendered HTML at this endpoint; Markdown conversion/sanitization is provider-adapter behavior.
- Signed attachmentRef must match body substitution and attachments exactly. Representative thumbnail mapping still needs one approved private live smoke before release qualification.
- App-owned runtime writes use Windforce Core ADR 0043. Issue #236 is complete and the target Cloud reports it deployed; independently probe the target runtime before a live login.