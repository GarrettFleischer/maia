/**
 * @fileoverview RTL tests for the shared AppHeader component.
 * @module __tests__/app/components/AppHeader.test
 */

import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import AppHeader from "@/app/components/AppHeader";

describe("AppHeader", () => {
  it("renders Maia title and nav links", () => {
    render(<AppHeader />);
    expect(screen.getByText("Maia")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /chat/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /agents/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    render(<AppHeader subtitle="AI Agent System" />);
    expect(screen.getByText("AI Agent System")).toBeInTheDocument();
  });

  it("renders logo link to home", () => {
    render(<AppHeader subtitle="Settings" />);
    const logo = screen.getByRole("link", { name: "M" });
    expect(logo).toHaveAttribute("href", "/");
  });
});
