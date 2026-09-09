import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyBackgroundDomInput,
  applyBackgroundDomSecondaryClick,
  clickTauriTestElement,
  hoverTauriTestElement,
  secondaryClickTauriTestElement,
  setTauriTestInput,
} from "../scripts/dom-test-input.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function rendered(tag) {
  const element = document.createElement(tag);
  document.body.append(element);
  element.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 20 });
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

  it("delivers a secondary click through the right-button handlers", () => {
    const viewport = rendered("main");
    const events = [];
    const click = vi.fn();
    for (const type of ["mousedown", "mouseup", "contextmenu"])
      viewport.addEventListener(type, (event) =>
        events.push({
          type: event.type,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    viewport.addEventListener("click", click);

    const evidence = applyBackgroundDomSecondaryClick(viewport);

    expect(events).toEqual(
      [
        ["mousedown", 2],
        ["mouseup", 0],
        ["contextmenu", 0],
      ].map(([type, buttons]) => ({ type, button: 2, buttons, clientX: 60, clientY: 30 })),
    );
    expect(click).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      mode: "background-dom",
      input: "secondary-click",
      trusted: false,
      clientX: 60,
      clientY: 30,
      events,
    });
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

  it("uses native WebDriver hover in the default visible mode", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "0");
    const browser = { execute: vi.fn() };
    const element = { moveTo: vi.fn() };
    await hoverTauriTestElement(browser, element);
    expect(element.moveTo).toHaveBeenCalledOnce();
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("uses DOM hover only for an explicitly background run", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "1");
    const browser = { execute: vi.fn().mockResolvedValue({ input: "hover", trusted: false }) };
    const element = { moveTo: vi.fn() };
    await hoverTauriTestElement(browser, element);
    expect(browser.execute).toHaveBeenCalledWith(expect.any(Function), element, "hover");
    expect(element.moveTo).not.toHaveBeenCalled();
  });

  it("uses a native WebDriver secondary click in the default visible mode", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "0");
    const browser = { execute: vi.fn() };
    const element = { click: vi.fn() };
    await secondaryClickTauriTestElement(browser, element);
    expect(element.click).toHaveBeenCalledWith({ button: "right" });
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("uses DOM secondary-click handlers only for an explicitly background run", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "1");
    const browser = {
      execute: vi.fn().mockResolvedValue({ input: "secondary-click", trusted: false }),
    };
    const element = { click: vi.fn() };
    await secondaryClickTauriTestElement(browser, element);
    expect(browser.execute).toHaveBeenCalledWith(expect.any(Function), element, "secondary-click");
    expect(element.click).not.toHaveBeenCalled();
  });

  it("keeps every background action self-contained after WebDriver serialization", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "1");
    vi.stubGlobal("PointerEvent", MouseEvent);
    const button = rendered("button");
    const click = vi.fn();
    button.addEventListener("click", click);
    const input = rendered("input");
    const values = [];
    input.addEventListener("input", () => values.push(input.value));
    input.addEventListener("change", () => values.push(input.value));
    const hoverTarget = rendered("div");
    const hoverEvents = [];
    for (const type of ["pointermove", "mousemove"])
      hoverTarget.addEventListener(type, (event) => hoverEvents.push(event.type));
    const viewport = rendered("main");
    const events = [];
    for (const type of ["mousedown", "mouseup", "contextmenu"])
      viewport.addEventListener(type, (event) => events.push(event.type));
    const evidence = [];
    const browser = {
      execute: vi.fn(async (script, ...arguments_) => {
        const isolated = runInThisContext(`(${script.toString()})`);
        const result = isolated(...arguments_);
        evidence.push(result);
        return result;
      }),
    };

    await clickTauriTestElement(browser, button);
    await setTauriTestInput(browser, input, "42");
    await hoverTauriTestElement(browser, hoverTarget);
    await secondaryClickTauriTestElement(browser, viewport);

    expect(click).toHaveBeenCalledOnce();
    expect(values).toEqual(["42", "42"]);
    expect(hoverEvents).toEqual(["pointermove", "mousemove"]);
    expect(events).toEqual(["mousedown", "mouseup", "contextmenu"]);
    expect(evidence).toMatchObject([
      { input: "click", trusted: false },
      { input: "value", previousValue: "", trusted: false },
      { input: "hover", trusted: false },
      { input: "secondary-click", trusted: false },
    ]);
    expect(browser.execute.mock.calls.map(([, , action]) => action)).toEqual([
      "click",
      "value",
      "hover",
      "secondary-click",
    ]);
  });
});
