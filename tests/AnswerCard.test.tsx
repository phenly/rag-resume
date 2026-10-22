import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnswerCard } from "@/components/AnswerCard";

describe("AnswerCard", () => {
  it("never renders images or live links from answers", () => {
    const { container } = render(
      <AnswerCard
       
        text="![x](https://evil.example/a.png) [y](https://evil.example)"
        status="complete"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("y")).toBeInTheDocument();
  });

  it("renders Based on line only when complete", () => {
    const text = "Body text.\n\nBased on: Doc A";
    const { rerender } = render(<AnswerCard text={text} status="streaming" />);
    expect(screen.queryByText(/Based on/)).toBeNull();
    rerender(<AnswerCard text={text} status="complete" />);
    expect(screen.getByText(/Based on: Doc A/)).toBeInTheDocument();
  });

  it("shows a spinner only while streaming", () => {
    const { rerender } = render(<AnswerCard text="" status="streaming" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<AnswerCard text="x" status="complete" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a note for incomplete answers", () => {
    render(<AnswerCard text="partial" status="incomplete" />);
    expect(screen.getByText("The answer hit its length limit.")).toBeInTheDocument();
  });
});
