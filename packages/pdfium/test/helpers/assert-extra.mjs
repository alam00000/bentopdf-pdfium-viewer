import test from 'node:test';
import assert from 'node:assert/strict';

export function closeTo(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

export function knownGap(name, fn) {
  test(`${name} [known gap]`, async () => {
    let failed = false;
    try {
      await fn();
    } catch {
      failed = true;
    }
    assert.ok(
      failed,
      'this known gap now behaves correctly — drop the knownGap wrapper and assert it directly',
    );
  });
}
