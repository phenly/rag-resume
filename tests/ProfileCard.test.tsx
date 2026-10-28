import { fireEvent, render, screen } from "@testing-library/react";
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

  it("leaves the blurb and how-it-works link to the chat app", () => {
    render(<ProfileCard profile={profile} />);
    expect(screen.queryByText(profile.blurb)).toBeNull();
    expect(screen.queryByRole("link", { name: /how this works/i })).toBeNull();
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

describe("ProfileCard photo", () => {
  it("renders an img with alt=name when photoUrl is given", () => {
    render(<ProfileCard profile={profile} photoUrl="/api/photo" />);
    const img = screen.getByRole("img", { name: "Jordan Example" });
    expect(img).toHaveAttribute("src", "/api/photo");
    expect(screen.queryByText("JE")).toBeNull();
  });

  it("shows initials when there is no photoUrl", () => {
    render(<ProfileCard profile={profile} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("JE")).toBeInTheDocument();
  });

  it("falls back to initials when the image fails to load", () => {
    render(<ProfileCard profile={profile} photoUrl="/api/photo" />);
    fireEvent.error(screen.getByRole("img", { name: "Jordan Example" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("JE")).toBeInTheDocument();
  });
});
