export const INVITE_COOKIE = "invite";

export type InviteResult = { kind: "pass" } | { kind: "deny" } | { kind: "set-cookie"; token: string };

/** Valid tokens from INVITE_TOKENS (comma-separated). Empty set means the gate is off. */
export function inviteTokens(configured: string | undefined): Set<string> {
  return new Set(
    (configured ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== ""),
  );
}

export function checkInvite(input: {
  queryToken: string | null;
  cookieToken: string | null;
  configured: string | undefined;
}): InviteResult {
  const tokens = inviteTokens(input.configured);
  if (tokens.size === 0) return { kind: "pass" };
  if (input.queryToken !== null) {
    return tokens.has(input.queryToken) ? { kind: "set-cookie", token: input.queryToken } : { kind: "deny" };
  }
  return input.cookieToken !== null && tokens.has(input.cookieToken) ? { kind: "pass" } : { kind: "deny" };
}
