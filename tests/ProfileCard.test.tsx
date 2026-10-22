import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProfileCard } from "@/components/ProfileCard";
import type { Profile } from "@/lib/corpus";

const profile: Profile = {
  name: "Jordan Example",
  headline: "Engineering leader",
  about: "About Jordan.",
  links: [{ label: "Portfolio", url: "https://example.com/j" }],
  blurb: "Ask anything.",
  starterQuestions: [],
  breakItQuestions: [],
};

describe("ProfileCard", () => {
  it("shows initials", () => {
    render(<ProfileCard profile={profile} />);
    expect(screen.getByText("JE")).toBeInTheDocument();
    expect(screen.getByText("Engineering leader")).toBeInTheDocument();
  });

  it("links to how-it-works", () => {
    render(<ProfileCard profile={profile} />);
    expect(screen.getByRole("link", { name: /how this works/i })).toHaveAttribute("href", "/how-it-works");
  });
});

describe("ProfileCard link safety", () => {
  it("renders non-http links as plain text without an href", () => {
    render(
      <ProfileCard
        profile={{
          ...profile,
          links: [
            { label: "Evil", url: "javascript:alert(1)" },
            { label: "Good", url: "https://example.com/g" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Evil")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Evil" })).toBeNull();
    expect(screen.getByRole("link", { name: "Good" })).toHaveAttribute("href", "https://example.com/g");
  });
});
