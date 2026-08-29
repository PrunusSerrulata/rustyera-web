import assert from "node:assert/strict";

export function assertStructuredSnakeProfileNotifications(state, visibleNotificationTexts) {
  const diagnostics = notifiedSnakeProfileDiagnostics(state);
  const notifications = Array.isArray(state?.logNotifications) ? state.logNotifications : [];
  assert.equal(
    notifications.length,
    diagnostics.length,
    "corner notifications must correspond one-to-one with structured snake diagnostics",
  );

  const unmatchedDiagnostics = [...diagnostics];
  for (const notification of notifications) {
    assert.equal(notification?.level, "warning", "snake profile notices must remain warnings");
    const index = unmatchedDiagnostics.findIndex((diagnostic) =>
      notificationMatchesDiagnostic(notification, diagnostic),
    );
    assert.notEqual(
      index,
      -1,
      `notification has no structured snake diagnostic: ${notification?.message}`,
    );
    unmatchedDiagnostics.splice(index, 1);
  }
  assert.deepEqual(unmatchedDiagnostics, []);

  const unmatchedVisible = [...visibleNotificationTexts];
  for (const notification of notifications) {
    const index = unmatchedVisible.findIndex((text) => String(text).includes(notification.message));
    assert.notEqual(
      index,
      -1,
      `structured notification is absent from the DOM: ${notification.message}`,
    );
    unmatchedVisible.splice(index, 1);
  }
  assert.deepEqual(unmatchedVisible, [], "DOM contains a notification absent from runtime state");
  return diagnostics;
}

export function notifiedSnakeProfileDiagnostics(state) {
  const records = Array.isArray(state?.serviceEvidence?.records)
    ? state.serviceEvidence.records
    : [];
  return records
    .filter((record) => record?.direction === "receive" && record?.message?.type === "diagnostic")
    .map((record) => record.message.value)
    .filter(isNotifiedSnakeProfileDiagnostic);
}

function isNotifiedSnakeProfileDiagnostic(diagnostic) {
  const context = diagnostic?.context;
  const identity = context?.identity;
  return (
    diagnostic?.level === "warning" &&
    diagnostic?.notification === "default" &&
    typeof diagnostic?.code === "string" &&
    diagnostic.code.length > 0 &&
    typeof diagnostic?.message === "string" &&
    diagnostic.message.length > 0 &&
    identity?.profile === "emuera.skia.snake" &&
    isPositiveInteger(identity.semantic_version) &&
    isPositiveInteger(identity.policy_version) &&
    typeof context?.stage === "string" &&
    context.stage.length > 0 &&
    isOptionalGeneration(context.generation)
  );
}

function notificationMatchesDiagnostic(notification, diagnostic) {
  const identity = diagnostic.context.identity;
  const message = String(notification?.message ?? "");
  return (
    message.includes(`[${diagnostic.code}]`) &&
    message.includes(diagnostic.message) &&
    message.includes(
      `profile=${identity.profile}@${identity.semantic_version}/${identity.policy_version}`,
    ) &&
    message.includes(`stage=${diagnostic.context.stage}`)
  );
}

function isPositiveInteger(value) {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "bigint" && value > 0n)
  );
}

function isOptionalGeneration(value) {
  return (
    value == null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "bigint" && value >= 0n)
  );
}
