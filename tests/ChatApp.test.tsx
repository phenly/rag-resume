import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/ChatApp";
import { ProfileCard } from "@/components/ProfileCard";

const profile = {
  name: "Jordan Example",
  headline: "Engineering leader",
  about: "About Jordan.",
  links: [{ label: "Portfolio", url: "https://example.com/j" }],
  blurb: "Ask anything.",
  starterQuestions: ["Starter one?", "Starter two?"],
  breakItQuestions: ["Break it?"],
};
const props = {
  profileCard: <ProfileCard profile={profile} />,
  candidateName: profile.name,
  starterQuestions: profile.starterQuestions,
  breakItQuestions: profile.breakItQuestions,
  blurb: profile.blurb,
};

function stubMatchMedia(desktop: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    media: query,
    get matches() { return query === "(width > 768px)" ? desktop : !desktop; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })));
  return (next: boolean) => act(() => {
    desktop = next;
    listeners.forEach((listener) => listener());
  });
}

beforeEach(() => {
  stubMatchMedia(true);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("ChatApp", () => {
  it("shows the top bar title and a Menu button", () => {
    render(<ChatApp {...props} />);
    expect(screen.getByRole("heading", { name: "CV-AI · Ask about Jordan Example" })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Menu" });
    expect(document.getElementById(button.getAttribute("aria-controls")!)).toBeInTheDocument();
  });

  it("desktop: menu pinned open by default; hamburger collapses and re-opens it", () => {
    render(<ChatApp {...props} />);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Menu" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent question" } });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary", { name: "Menu" })).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Menu" })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Unsent question");
  });

  it("phone: menu closed by default; opens as a dialog; closes on Escape and backdrop click", () => {
    stubMatchMedia(false);
    render(<ChatApp {...props} />);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Close menu backdrop" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("phone: picking a break-it question fills the composer and closes the menu", () => {
    stubMatchMedia(false);
    render(<ChatApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Try to break it (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Break it?" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box).toHaveValue("Break it?");
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(box.value.length);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("crossing to desktop while the phone menu is open removes the backdrop", () => {
    const resize = stubMatchMedia(false);
    render(<ChatApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("button", { name: "Close menu backdrop" })).toBeInTheDocument();
    resize(true);
    expect(screen.queryByRole("button", { name: "Close menu backdrop" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Menu" })).toBeVisible();
    resize(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("About Kevin shows the profile card; How this works links to /how-it-works", () => {
    render(<ChatApp {...props} />);
    const about = screen.getByRole("region", { name: "About Kevin" });
    expect(within(about).getByRole("heading", { name: "Jordan Example" })).toBeInTheDocument();
    expect(within(about).getByText("Engineering leader")).toBeInTheDocument();
    expect(within(about).getByText("About Jordan.")).toBeInTheDocument();
    expect(within(about).getByRole("link", { name: "Portfolio" })).toHaveAttribute("href", "https://example.com/j");
    expect(screen.getByRole("link", { name: "How this works" })).toHaveAttribute("href", "/how-it-works");
    const menu = screen.getByRole("complementary", { name: "Menu" });
    const clear = within(menu).getByRole("button", { name: "Clear chat" });
    expect(clear.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("returns focus to Menu when resizing to phone hides a focused sidebar control", () => {
    const resize = stubMatchMedia(true);
    render(<ChatApp {...props} />);
    screen.getByRole("link", { name: "Portfolio" }).focus();
    resize(false);
    expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("phone: keeps keyboard focus inside the open menu and has a close button", () => {
    stubMatchMedia(false);
    render(<ChatApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const close = screen.getByRole("button", { name: "Close menu" });
    const last = screen.getByRole("button", { name: "Try to break it (1)" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.click(close);
    expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides break-it chips until opened, focuses the first chip, and collapses on a second click", () => {
    render(<ChatApp {...props} />);
    expect(screen.queryByRole("button", { name: "Break it?" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Try to break it (1)" });
    expect(toggle).toHaveAttribute("aria-controls", "break-it-chips");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Break it?" })).toHaveFocus();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Break it?" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking the same chip twice keeps focus in the box and typing does not move the caret", () => {
    render(<ChatApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Try to break it (1)" }));
    const chip = screen.getByRole("button", { name: "Break it?" });
    fireEvent.click(chip);
    fireEvent.click(chip);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(box.value.length);
    box.setSelectionRange(3, 3);
    fireEvent.change(box, { target: { value: "Brexak it?" } });
    box.setSelectionRange(5, 5);
    expect(box.selectionStart).toBe(5);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Menu" })).toBeVisible();
  });

  it("phone: Escape still closes the menu after clicking non-focusable content inside it", () => {
    stubMatchMedia(false);
    render(<ChatApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    const text = screen.getByText("About Jordan.");
    // A real click on non-focusable content moves focus to the nearest focusable ancestor.
    act(() => dialog.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(text, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Clear chat clears unsent composer text", () => {
    render(<ChatApp {...props} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("phone: the menu closes after pressing Clear chat", () => {
    stubMatchMedia(false);
    render(<ChatApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("server render and hydration leave the menu to CSS (no JS viewport guess)", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(<ChatApp {...props} />);
    expect(html).toContain('data-auto="true"');
    expect(html).not.toMatch(/<aside[^>]*\shidden/);
    expect(html).toContain("autoMenu");
  });

  it("uses range-syntax queries so there is no fractional-width gap", () => {
    render(<ChatApp {...props} />);
    const queries = (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queries).toContain("(width > 768px)");
    expect(queries.some((q: string) => /min-width|max-width/.test(q))).toBe(false);
  });

  it("renders no break-it toggle for an empty list", () => {
    render(<ChatApp {...props} breakItQuestions={[]} />);
    expect(screen.queryByRole("button", { name: /break it/i })).toBeNull();
  });
});
