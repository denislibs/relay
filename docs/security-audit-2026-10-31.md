# Relay security audit — 2026-10-31 (attacker-perspective, read-only)

Target: local app at HEAD `c784a2ad`. Method: four parallel code audits (auth/sessions,
authorization/IDOR, client XSS/content-injection, file-serving/uploads/SSRF). Every finding
below was re-verified by hand in the source. Attacker model = an ordinary user with one or two
accounts (unless noted). No code was changed and the app was not exploited live.

Bottom line: the auth core, crypto, CSP/Trusted-Types, file-serving MIME handling, link-preview
SSRF defence and media-job command-injection surface are **solid** and most 2026-10-25 fixes hold.
The real gaps (one HIGH, five MEDIUM) are in **authorization breadth** (who you may turn into a "peer", what a fresh or
hijacked session may do) and two **egress/exfiltration** paths (profile-music, Web Push).

---

## HIGH

### H1 — Any user id can be forced into a shared chat, defeating the anti-enumeration design
`apps/server/src/domain/chats.ts:74` (`openDirect`) and `:33` (`createGroup`) accept a raw target
id and only check "user exists / not system" (groups also reject mutual blocks). Creating a direct
chat makes you *share a non-channel chat* with the victim — which is exactly the gate
`profile.ts:131 canView` relies on. The code comment states the goal ("иначе перебором id можно
узнать всех"); this bypasses it.
- Steps: for id = 1..N, `POST /chats/direct {"userId":N}` (404 = no user → enumeration oracle;
  200 = chat). Then `GET /users/N` (name, username, bio, birthday, links, photo, personal channel,
  music — defaults are `everyone`), `GET /users/N/photos` (full photo history), `GET /presence` +
  live `presence` frames (`presence.ts` includes direct-chat peers) → online/last-seen tracking of
  anyone. `POST /chats {memberIds:[N]}` additionally force-adds the victim to a group (no
  "who can add me" privacy key) and pushes the attacker's profile to them.
- Impact: mass enumeration + profile/photo/presence disclosure of arbitrary users regardless of
  their privacy settings; unsolicited DMs; forced group membership.
- Fix: require an existing relationship (contact, common chat, or @username/phone resolution
  subject to discovery settings) before `openDirect`/`createGroup`/add-members accept a bare id.

---

## MEDIUM

### M1 — Protected-chat / hidden-history audio exfiltration, made world-readable, via "profile music"
`apps/server/src/domain/profileMusic.ts:27` (`addProfileMusic`) only calls `assertMember` — no
`m.id >= cm.history_from`, no `chat.protected` check, and works for channel subscribers. The track
name is decrypted and stored in plaintext. Once added, `fileFor` (`files.ts:296`) serves the file
to **every** logged-in user, `attachmentForSend` (`files.ts:242`) lets the attacker re-send it
anywhere (bypassing "no forwarding"), and the row survives the attacker leaving/being kicked.
`GET /users/:id/music` has no `canView` check at all.
- Steps: as a member who joined after an audio message (hidden history), learn its id (ids are a
  single global sequence; reply pointers leak earlier ids; `/me/music` is unrated) →
  `POST /me/music {chatId, messageId}` → the file and name are now public and re-sendable.
- Fix: in `addProfileMusic`, join `chat_members` with `m.id >= cm.history_from` and reject
  `protected` chats; add `canView` to `/users/:id/music`; ideally copy the object into an
  owner-owned attachment on add.

### M2 — Unlimited online brute force of the 2FA cloud password (owner-transfer path)
`apps/server/src/domain/groups.ts:532` → `checkPassword = verifyProof` (`password.ts:95`) has **no**
wrong-attempt counter — unlike the login path's `checkPending` (`password.ts:116`, which enforces
`wrongLastHour >= 10`). SRP challenges are free for any session
(`authRoutes.ts:144 /settings/password/challenge`).
- Steps: from a hijacked/second session, create a throwaway group you own, then loop
  challenge→proof against `POST /groups/:id/owner` with dictionary guesses — no lockout.
- Impact: online dictionary attack on the cloud password (online only; SRP, so no offline attack),
  far above the 10/hour the login path enforces.
- Fix: route `checkPassword` through the same per-hour wrong-attempt counter used by `checkPending`.

### M3 — Fresh / unconfirmed (e.g. stolen) session can trigger irreversible crypto-shred
`assertConfirmed` guards sessions-TTL and the auth routes, but **not**: `DELETE /groups/:id`
(`groups.ts:592 deleteGroup` → `deleteGroupTx` deletes `chat_keys`, an irreversible crypto-shred
of a whole channel), `POST /chats/:id/delete {forAll:true}` (`chats.ts:528`), owner transfer
(`groups.ts:526`), public-@username release. A session still in its first-24h "restricted" window —
or a freshly stolen long cookie — can run these.
- Fix: gate destructive/ownership actions with `assertConfirmed` (the service-chat "это вы?" flow
  already exists for session actions).

### M4 — Web Push subscription is an unrestricted outbound POST (blind SSRF)
`apps/server/src/domain/push.ts:77` (`subscribe`) accepts any `https:` endpoint — any host, **any
port**, any path (`http:` too under `DEV_LOGIN`). No `isPublicIp`/`resolvePublic` guard, unlike
`linkPreview.ts`. `deliverPush` (`push.ts:202`) then `fetch`es it (POST, VAPID-signed body, retried
on 5xx/429). The worker trusts the internal CA and can reach `https://keys:7800`,
`https://search:7700`, `https://s3:8333`.
- Steps: `POST /push/subscription {endpoint:"https://keys:7800/…", keys:{valid p256dh/auth}}`; go
  offline; have a second account message you → worker POSTs to the internal host.
- Impact: attacker-timed POSTs to arbitrary internal https hosts/ports/paths. Body is not
  attacker-controlled and the response is not returned (blind), so impact is bounded, but it is a
  real egress hole that the link-preview code deliberately closes.
- Fix: run the endpoint host through `resolvePublic`/`isPublicIp`, pin the IP, force port 443 and
  https, and/or allowlist known push-service origins.

### M5 — Brute-force limits on 2FA password & recovery are TOCTOU-racy
`apps/server/src/domain/password.ts:116` (`checkPending`) and `:149` (`finishRecovery`) read the
attempt count and then update it in **separate** autocommit statements with no row lock — unlike the
login code path (`login.ts:132`) which does it in one tx with `for update`. Firing N proofs
concurrently all read `tries=0`/`wrong<limit` before any update commits.
- Impact: well above the intended 5-per-pending / 10-per-hour on the 2FA password (N bounded by DB
  pool concurrency). Recovery code space (1e6) stays impractical even so.
- Fix: do the count-and-increment inside one transaction with `for update` / an advisory lock, as
  the login path already does.

---

## LOW / notes (real, lower impact)

- **Dev stand only: `/auth/code` returns the login code (`devCode`) without a `devAllowed()` IP
  check** (`authRoutes.ts:72`, `login.ts:119`). Not a production risk: prod has no dev-stand logic
  (`DEV_LOGIN=1` is refused at startup). Matters only if a dev stand is exposed off-host
  (`RELAY_BIND=0.0.0.0`); gating it with `devAllowed` would make it consistent with `/dev/*`.
- **Unbound-session contract is weaker than `SECURITY.md` claims.** A client that omits `device`
  (`apps/web/.../auth/api.ts` swallows key-gen failure) gets a long cookie that grants full API
  access forever (`auth.ts:83`), and `POST /session/refresh` lets whoever presents the long cookie
  *first* bind their own key (`deviceAuth.ts`), locking the real owner out. Fix server-side: reject
  logins without `device` in production.
- **Link-text spoofing / phishing** (`richview.js:27`, `richtext.js:173`): a `link` entity's `url`
  need not match the visible text, and `entityUrl` allows `user@host` userinfo hosts; no
  open-link confirmation. One-click credential/QR phishing of other users. No XSS. Fix: warn when
  entity host ≠ visible host; strip userinfo.
- **Public-channel previewer keeps receiving posts after the channel goes private**
  (`sockets.ts:67` watcher not re-checked when `username` is removed; `realtime.ts:93` sends full
  items). Fix: drop/re-check watchers on membership-affecting `groupUpdated`.
- **Block bypasses**: a blocked user can still pin/unpin, mark-listened, and `deleteDir(forAll)`
  in the blocker's direct chat (`pins.ts`, `messageOps.ts markListened`, `chats.ts`).
- **Non-anonymous channel polls leak voter identities** (`polls.ts:33` doesn't force anonymity;
  `pollVoters` only checks membership) — contradicts the member-list anonymity invariant. Several
  poll/`markListened`/pin/reply-target/`getThread` paths also ignore `history_from`.
- **Push endpoint re-own** (`push.ts:93 on conflict … set user_id = excluded`): anyone who learns a
  victim's endpoint URL can take it over and silence their notifications.
- **`/dev/login` login-CSRF** (`http.ts:131`, handled before `signInRequestOk`, parses any
  content-type) — dev-only.
- Name disclosure for arbitrary ids via contact cards (`messages.ts:160`) and non-anonymous
  channel polls; deviceAuth challenges replayable for 2 min; `emojiFx` rate key includes the
  attacker-chosen frame id.

---

## Verified solid (attacker could not break these)

- WS/open: no subscribe/registry/presence before `prove`; bound sessions need the short access
  cookie for `/ws` (AUTH-1). Session termination cascades + `pg_notify` + per-minute `checkSocket`.
- Login code brute force: 5 digits, 5 tries, 5/hr per login and per account, 30/hr per IP, inside
  one tx with advisory locks / `for update`; unknown logins get a random hash.
- Passkeys (one-shot challenge, origin/rpID from Host, counter), QR login (30s TTL, hash-only,
  one-shot, device-key match, WEB-1 hash dropped), SRP (A·u·M1 checks, atomic challenge consume).
- Cookies `__Host-…; Secure; HttpOnly; SameSite=Lax`; HSTS; XFF cannot be spoofed through nginx.
- Client XSS: no reachable script/attribute injection — strong CSP (`script-src 'self'
  'wasm-unsafe-eval'`, `require-trusted-types-for 'script'`, `object-src/frame-src 'none'`),
  Trusted Types + DOMPurify, SW never serves uploads for `mode:'navigate'`.
- File serving: `INLINE_MIME` allowlist else `octet-stream; attachment`; `Content-Disposition`
  filename sanitised+encoded (no header injection); `thumb` regex-validated, never in headers;
  encrypted files always octet-stream; verified against real S3.
- Link-preview SSRF (SSRF-1/2): http/https + ports 80/443 only, byte-level BlockList for private/
  loopback/mapped/6to4/ULA/link-local ranges, `lookup(all)` requiring every answer public, connect
  to pinned IP with Host/SNI, every redirect re-validated, no decompression, size/time caps.
- `:8333` S3 vhost passes only signed GET/HEAD/PUT with `X-Amz-Signature`, no `Authorization`;
  listing → 403.
- Media jobs: `Bun.spawn(argv)` no shell, fixed temp paths, `-protocol_whitelist file`, pixel caps;
  user metadata never reaches argv. Sticker/reaction/emoji routes have traversal guards + hash
  checks. Maptile z/x/y validated, type restricted.
- Upload authz scoped by `owner_id`; UPL-1 overwrite-after-confirm closed (one small pre-copy
  TOCTOU remains — declared size/type may not match the copied object; copy with
  `x-amz-copy-source-if-match` + re-stat).
