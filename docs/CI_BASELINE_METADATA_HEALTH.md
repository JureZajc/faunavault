# Metadata Health: CI baseline investigation

Investigated on 2026-10-29 against master
`fed7262b818a101a48094c14a51e7efeb8d9cb94`, which was also the starting commit of
`feature/metadata-health-workspace`.

## Existing frontend failure

[Master CI run 40839545517](https://github.com/JureZajc/faunavault/actions/runs/40839545517)
failed in the frontend `npm test` step. The backend and all three HEIC jobs passed.
The failed test was
`frontend/__tests__/tag-management.test.tsx` →
`preview errors are recoverable and editing invalidates a previous preview`.
At line 96, it expected the Confirm changes button to be absent after typing `2`
into the destination field. The button remained. CI reported 373 passed, 1 failed.

Before feature edits, the complete local frontend suite passed: 37 files,
374 tests. Ten further runs of the unchanged tag-management file from a pristine
`git archive master frontend` source snapshot also passed. The snapshot reused the
existing dependency installation; no production source or test assertions were
changed in the working checkout for this investigation.
Local runs used Windows and Node 24.12.0; the failed hosted run used Ubuntu and
Node 24.22.1. The passing local runs alone therefore do not prove hosted stability.

## Timing reproduction

The existing tag dialog schedules
`requestAnimationFrame(() => previewRef.current?.focus())` after loading a preview.
If that callback runs after the destination input receives focus but before the
next keystroke, it moves focus to the preview heading. The keystroke then does not
edit the input, so the preview correctly remains valid. This is independent of
metadata completeness filtering.

A controlled schedule reproduced the identical failure in the disposable master
snapshot. In the failing test only, after opening the dialog, capture the pending
frame rather than executing it immediately:

```tsx
let previewFocus: FrameRequestCallback | undefined;
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  previewFocus = callback;
  return 1;
});
```

Immediately before its final `userEvent.type(input, "2")`, run the pending frame
when the input receives focus:

```tsx
input.addEventListener("focus", () => previewFocus?.(0), { once: true });
```

The destination remained `birds`, and the original assertion that Confirm changes
must disappear failed exactly as in CI. No assertions were weakened or removed.
The instrumentation and source snapshot were discarded. This establishes a timing
reproduction; it does not establish the precise scheduler ordering in the hosted
run. The available evidence points to focus timing rather than cross-test state.

The tag dialog and its tests are left unchanged in this feature. A separate focused
fix can avoid stealing focus after a user has returned to the input and verify that
the destination actually changes before asserting preview invalidation. No broad
CI, dependency or test-runner refactoring is included.
