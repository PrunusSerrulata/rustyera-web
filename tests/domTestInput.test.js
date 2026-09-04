/* global document */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBackgroundDomInput } from "../scripts/dom-test-input.mjs";

afterEach(() => {
  document.body.replaceChildren();
});

function rendered(tag) {
  const element = document.createElement(tag);
  document.body.append(element);
  element.getBoundingClientRect = () => ({ width: 100, height: 20 });
  return element;
}

describe("explicit background DOM input", () => {
  it("invokes the real click handler and records untrusted input without focusing", () => {
    const button = rendered("button");
    const handler = vi.fn();
    const focus = vi.spyOn(button, "focus");
    button.addEventListener("click", handler);
    const evidence = applyBackgroundDomInput(button);
    expect(handler).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({ mode: "background-dom", trusted: false, input: "click" });
    expect(focus).not.toHaveBeenCalled();
  });

  it("delivers the changed value through input and change handlers", () => {
    const input = rendered("input");
    input.value = "old";
    const values = [];
    input.addEventListener("input", () => values.push(input.value));
    input.addEventListener("change", () => values.push(input.value));
    expect(applyBackgroundDomInput(input, "42")).toMatchObject({
      previousValue: "old",
      trusted: false,
    });
    expect(values).toEqual(["42", "42"]);
  });

  it("rejects unavailable targets before handlers run", () => {
    const button = rendered("button");
    const handler = vi.fn();
    button.addEventListener("click", handler);
    button.disabled = true;
    expect(() => applyBackgroundDomInput(button)).toThrow("rendered enabled");
    button.disabled = false;
    button.hidden = true;
    expect(() => applyBackgroundDomInput(button)).toThrow("rendered enabled");
    button.remove();
    expect(() => applyBackgroundDomInput(button)).toThrow("detached");
    expect(handler).not.toHaveBeenCalled();
  });
});
