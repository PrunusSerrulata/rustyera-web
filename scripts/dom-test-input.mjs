/* global document, navigator, getComputedStyle, HTMLInputElement, MouseEvent, PointerEvent */

// Explicit background coverage: real DOM handlers and host transport, without
// claiming trusted hardware input or bypassing the production interaction policy.
export function applyBackgroundDomAction(element, action, value = null, beforeDispatch = null) {
  if (!element?.isConnected) throw new Error("background input target is detached");
  const bounds = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (
    element.disabled ||
    element.closest('[inert], [hidden], [aria-disabled="true"]') ||
    style.display === "none" ||
    style.visibility !== "visible" ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    throw new Error("background input requires a rendered enabled target");

  const evidence = {
    mode: "background-dom",
    documentFocused: document.hasFocus(),
    visibility: document.visibilityState,
    activation: navigator.userActivation?.isActive ?? null,
    tag: element.tagName.toLowerCase(),
    input: action,
    trusted: null,
  };
  if (action === "click" || action === "value") {
    evidence.previousValue = "value" in element ? element.value : null;
    const eventName = action === "click" ? "click" : "input";
    const record = (event) => {
      evidence.trusted = event.isTrusted;
    };
    element.addEventListener(eventName, record, { once: true });
    try {
      if (action === "click") {
        beforeDispatch?.();
        element.click();
      } else {
        if (!(element instanceof HTMLInputElement)) throw new Error("input element required");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } finally {
      element.removeEventListener(eventName, record);
    }
    return evidence;
  }
  if (action === "hover") {
    const record = (event) => {
      evidence.trusted =
        evidence.trusted === null ? event.isTrusted : evidence.trusted && event.isTrusted;
    };
    element.addEventListener("pointermove", record, { once: true });
    element.addEventListener("mousemove", record, { once: true });
    try {
      beforeDispatch?.();
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    } finally {
      element.removeEventListener("pointermove", record);
      element.removeEventListener("mousemove", record);
    }
    return evidence;
  }
  if (action === "secondary-click") {
    const clientX = bounds.left + bounds.width / 2;
    const clientY = bounds.top + bounds.height / 2;
    evidence.clientX = clientX;
    evidence.clientY = clientY;
    evidence.events = [];
    beforeDispatch?.();
    for (const [type, buttons] of [
      ["mousedown", 2],
      ["mouseup", 0],
      ["contextmenu", 0],
    ]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons,
        clientX,
        clientY,
      });
      element.dispatchEvent(event);
      evidence.events.push({
        type,
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
        trusted: event.isTrusted,
      });
    }
    evidence.trusted = evidence.events.every((event) => event.trusted);
    return evidence;
  }
  throw new Error(`unsupported background DOM action ${action}`);
}

export function applyBackgroundDomInput(element, value = null) {
  return applyBackgroundDomAction(element, value == null ? "click" : "value", value);
}

export function applyBackgroundDomHover(element) {
  return applyBackgroundDomAction(element, "hover");
}

export function applyBackgroundDomSecondaryClick(element) {
  return applyBackgroundDomAction(element, "secondary-click");
}

export async function clickTauriTestElement(browser, element) {
  if (process.env.RUSTYERA_TEST_BACKGROUND_DOM !== "1") return element.click();
  const evidence = await browser.execute(applyBackgroundDomAction, element, "click");
  console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
}

export async function secondaryClickTauriTestElement(browser, element) {
  if (process.env.RUSTYERA_TEST_BACKGROUND_DOM !== "1") return element.click({ button: "right" });
  const evidence = await browser.execute(applyBackgroundDomAction, element, "secondary-click");
  console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
}

export async function setTauriTestInput(browser, element, value) {
  if (process.env.RUSTYERA_TEST_BACKGROUND_DOM !== "1") return element.setValue(value);
  const evidence = await browser.execute(applyBackgroundDomAction, element, "value", value);
  console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
}

export async function hoverTauriTestElement(browser, element) {
  if (process.env.RUSTYERA_TEST_BACKGROUND_DOM !== "1") return element.moveTo();
  const evidence = await browser.execute(applyBackgroundDomAction, element, "hover");
  console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
}
