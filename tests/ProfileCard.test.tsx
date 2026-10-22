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
