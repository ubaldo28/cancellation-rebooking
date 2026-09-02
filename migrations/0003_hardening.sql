-- Hardening pass.

-- Fixed-window rate limiting. Cloudflare's own rate-limiting binding is the
-- better tool at scale, but it is configured outside the code and cannot see
-- per-email keys, which is exactly what the sign-in endpoint needs to stop
-- someone hammering one mailbox or mass-creating operator rows.
CREATE TABLE rate_limits (
  bucket_key    TEXT PRIMARY KEY,   -- e.g. 'auth:me@example.com' or 'auth-ip:1.2.3.4'
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);

-- messages is written on every offer and read per operator in the dashboard;
-- it had no operator-scoped index, so that read was a full scan.
CREATE INDEX idx_messages_operator ON messages (operator_id, created_at);

-- Cancellations are how gaps are born, so the dashboard reads them constantly.
CREATE INDEX idx_appts_cancelled ON appointments (operator_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;

-- Completed jobs drive the cadence recompute; without this the nightly pass
-- scans every appointment ever booked.
CREATE INDEX idx_appts_completed ON appointments (operator_id, status, ends_at)
  WHERE status = 'completed';
