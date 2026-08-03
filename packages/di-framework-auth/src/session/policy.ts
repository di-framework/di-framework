/**
 * Session lifetime policy, per NIST SP 800-63B §7.1–7.2.
 *
 * Two independent clocks. The absolute timeout is a hard ceiling on how long one
 * authentication event can grant access, regardless of activity. The inactivity
 * timeout ends sessions that are merely abandoned. Only having the second means
 * an attacker who steals a session and keeps it warm holds it forever.
 */
export interface SessionPolicy {
  /** Seconds from authentication to forced re-authentication. */
  absoluteTimeoutSeconds: number;
  /** Seconds of inactivity before the session ends. `0` disables the check. */
  inactivityTimeoutSeconds: number;
  /**
   * Minimum seconds between `lastSeenAt` writes.
   *
   * Without this, every authenticated request writes to the session store. The
   * cost of throttling is that the inactivity window is imprecise by up to this
   * many seconds, which does not matter for a 30-minute window.
   */
  touchIntervalSeconds: number;
}

/**
 * AAL1 — "some assurance". SP 800-63B Table 4-1: 30-day reauthentication, no
 * inactivity requirement. Suitable for low-risk consumer sessions.
 */
export const AAL1_POLICY: SessionPolicy = {
  absoluteTimeoutSeconds: 30 * 24 * 60 * 60,
  inactivityTimeoutSeconds: 0,
  touchIntervalSeconds: 300,
};

/**
 * AAL2 — "high confidence", the default. SP 800-63B Table 4-1: reauthenticate at
 * 12 hours regardless of activity, and after 30 minutes of inactivity.
 */
export const AAL2_POLICY: SessionPolicy = {
  absoluteTimeoutSeconds: 12 * 60 * 60,
  inactivityTimeoutSeconds: 30 * 60,
  touchIntervalSeconds: 60,
};

/** AAL3 — "very high confidence": 12 hours absolute, 15 minutes inactivity. */
export const AAL3_POLICY: SessionPolicy = {
  absoluteTimeoutSeconds: 12 * 60 * 60,
  inactivityTimeoutSeconds: 15 * 60,
  touchIntervalSeconds: 60,
};

export const DEFAULT_SESSION_POLICY = AAL2_POLICY;

export function resolveSessionPolicy(policy?: Partial<SessionPolicy>): SessionPolicy {
  const resolved = { ...DEFAULT_SESSION_POLICY, ...policy };
  if (resolved.absoluteTimeoutSeconds <= 0) {
    throw new RangeError('absoluteTimeoutSeconds must be positive');
  }
  if (resolved.inactivityTimeoutSeconds < 0) {
    throw new RangeError('inactivityTimeoutSeconds must not be negative');
  }
  return resolved;
}
