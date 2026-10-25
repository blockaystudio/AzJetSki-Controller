# Shop access and private customer links

The access-security module protects password/PIN sign-in with persistent failure throttling. By default, six failures for the same account and source within fifteen minutes cause a temporary block; a separate source limit covers username spraying. Forwarded source/protocol headers are trusted only with `TRUST_PROXY=true` behind a controlled proxy that strips untrusted forwarding headers. Do not enable it for arbitrary direct Internet clients.

Configure `PUBLIC_BASE_URL` to the shop's exact HTTPS origin. Session cookies use HttpOnly, SameSite=Strict, and Secure for HTTPS deployments. Sessions expire after twelve hours. Explicit cross-origin unsafe requests fail; native app requests without Origin remain supported. Identity changes (password, PIN, active status, role or username) revoke existing sessions. Owners can list and revoke sessions from the access panel; token hashes are never shown there.

## Employee recovery

An authenticated owner may create a one-time fifteen-minute employee recovery link. Deliver it privately; creating it does not send email. The link token is hashed in the database and omitted from audit records. A completed recovery changes the password, removes the old PIN, and revokes all prior sessions. The employee must sign in again. Expired, revoked or already-used links cannot be reused. This workflow does not offer a public username lookup or a public account enumeration endpoint.

If the sole owner cannot sign in, run this command **locally on the protected shop computer**, from the `Windows-Server` folder:

```sh
node scripts/recover-owner.mjs OWNER_USERNAME
```

The command requires an existing database and an existing active owner. It prints a private recovery link to that local terminal only, and never overwrites a database or creates a replacement owner. Keep the terminal output private. Open the link while the shop server is running. Filesystem access to the live database is privileged administrative access and must be protected by the operating system.

## Customer links

Customer links are random bearer capabilities for one work order. Default links show only customer-visible repair updates and photos; document-enabled links additionally show that work order's active issued invoices and retained completed authorizations. Internal notes, private photos, another customer's records, and staff controls are not exposed. Links expire after thirty days by default, with staff able to select one to ninety days, list link history and revoke a link with a reason. Unlimited legacy links receive a bounded expiry.

Customer responses and images use no-store and no-referrer headers. Revocation and exact-time expiry apply to every new request, including images and document routes. Previously downloaded copies cannot be withdrawn from the customer's device. Keep links private and revoke them if sent to the wrong recipient. Staff-created links do not automatically notify the customer; delivery status belongs to the communications workflow.

Remote deployment still requires working HTTPS hosting, correct DNS/proxy configuration and shop acceptance tests. These access controls do not certify provider integrations or legal authorization terms.
