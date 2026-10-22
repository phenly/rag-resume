import { describe, expect, it } from "vitest";
import { redactContacts } from "@/lib/redact";

describe("redactContacts", () => {
  it("redacts emails, phone formats and street addresses", () => {
    const out = redactContacts(
      "Mail a.b@example.com or call (555) 010-4477, 555-010-4477, 555.010.4477. Lives at 42 Pelican Way, Unit 3 today.",
    );
    expect(out).not.toContain("@example.com");
    expect(out).not.toContain("010-4477");
    expect(out).not.toContain("010.4477");
    expect(out).not.toContain("Pelican");
    expect(out).toContain("[email removed]");
    expect(out).toContain("[phone removed]");
    expect(out).toContain("[address removed]");
  });

  it("leaves years, money, IDs and city/state alone", () => {
    const s = "2019–2024, $2.5M, [ACM-PLT-01], Boston, MA";
    expect(redactContacts(s)).toBe(s);
  });
});
