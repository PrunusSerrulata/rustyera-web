/* global document, navigator, getComputedStyle, HTMLInputElement */

// Explicit background coverage: real DOM handlers and host transport, without
// claiming trusted hardware input or bypassing the production interaction policy.
export function applyBackgroundDomInput(element, value = null) {
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
    input: value == null ? "click" : "value",
    previousValue: "value" in element ? element.value : null,
    trusted: null,
  };
  const eventName = value == null ? "click" : "input";
  const record = (event) => {
    evidence.trusted = event.isTrusted;
  };
  element.addEventListener(eventName, record, { once: true });
  try {
    if (value == null) element.click();
    else {
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

export async function clickTauriTestElement(browser, element) {
  if (process.env.RUSTYERA_TEST_BACKGROUND_DOM !== "1") return element.click();
  const evidence = await browser.execute(applyBackgroundDomInput, element);
  console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
}

export async function setTauriTestInput(browser, element, value) {
  if (process.env.RUSTYERA_TEST_BACKGROUND_DOM !== "1") return element.setValue(value);
  const evidence = await browser.execute(applyBackgroundDomInput, element, value);
  console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
}
