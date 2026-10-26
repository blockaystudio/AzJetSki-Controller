# A04 / A06 communication repairs

Implemented in `shop-mail.mjs`, `service-notifications.mjs`, and the outbox/appointment portions of `shop-management.mjs`. Other agents own receiving changes in the shared management file and server callback wiring.

- SMTP error, close, end, idle timeout and response timeout settle the current waiter once; late errors during destroy remain handled. Before DATA, connection failure is a definitive nonacceptance and can retry. An explicit final 4xx/5xx is classified by its code. Loss after writing the message is `delivery_unknown` and never automatically retried. A final 250 remains accepted even if QUIT fails. Acceptance is never called inbox delivery.
- Reminder outbox records bind immutable `appointment_id` and `appointment_revision`. Appointment changes cancel draft/pending reminders atomically; consent updates cannot revive them. Queue, manual retry and dispatch revalidate the appointment, customer, revision and future start. Existing unbound reminder records are retained as cancelled history. Accepted/uncertain attempt history is preserved.
- Appointment PATCH invokes the synchronous durable `notify` callback inside its transaction. Its response includes `notification` alongside truthful `calendarSync`. The server now wires the normal notification queue callback. Nested queue writes use savepoints; outer management transactions retain `BEGIN IMMEDIATE`. Network sending occurs outside these transactions.

Validation used Node 22.23.4 with an empty environment plus a minimal PATH/HOME and NODE_ENV=test. SMTP tests inject EventEmitter sockets and fake credentials; SQLite fixtures are in memory. No real messages or remote connections were used.

- `node Windows-Server/test/shop-mail.test.mjs`: 9 tests/subtests passed, including error/close/end/timeout, fragmented/multiline responses, 4xx/5xx, ambiguous DATA acceptance, failed QUIT and the actual outbox SMTP adapter.
- `node Windows-Server/test/service-notifications.test.mjs`: 19 tests/subtests passed, including reschedule/cancel routes, seven pending states, consent withdrawal/regrant, dispatch after a bypassed invalidation trigger, elapsed reminders, retained history, legacy migration and callback rollback.
- `node Windows-Server/test/shop-management.test.mjs`: 10 passed, including existing purchasing/receiving and notification behavior.
- `git diff --check`: passed.

A reminder whose provider attempt has already started cannot be recalled. Changes invalidate pending reminders and dispatch checks immediately before calling the provider; in-flight attempts retain their actual acceptance/uncertainty history. Live SMTP/inbox and provider acceptance remain shop deployment checks.
