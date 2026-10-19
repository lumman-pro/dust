# Live QA for `dust-yukify`

Read this file completely before exercising a preview or a local environment. Live QA is opt-in:
run it only when the user asks for it or hands over a URL or a running environment.

## Contents

- Preconditions
- Environments
- State matrix
- Evidence
- Reporting

## Preconditions

- Use the built-in browser unless the user asks for another one.
- Never use production. Never sign in with credentials yourself unless the session's rules allow
  test credentials for that environment; otherwise ask the user to sign in.
- Exercise the changed flows only. Do not trigger destructive or shared-state actions (deleting,
  revoking, inviting real people, sending emails) unless the user asks for that specific action.
- Check which commit the preview was built from before reporting a bug. A stale preview produces
  false findings.

## Environments

- **SPA preview of a PR**: the `<!-- spa-preview-app -->` comment on the PR links
  `https://pr-<number>-merge--app.preview.dust.tt`. Read it with `gh pr view <number> --comments`.
- **Sparkle Storybook preview**: Sparkle PRs get a Storybook deployment linked from a bot comment.
  Use it to check a component in isolation, with every variant the story exposes.
- **Local environment**: load the `dust-hive` skill and use the hive's own forwarded port. The
  front-spa entry point is the app root URL with no path.

## State matrix

Walk each changed surface through every row that applies:

1. **First paint and loading**: hard reload and watch the transition from loader or skeleton to
   content. Anything that moves, resizes, or appears late is a layout shift.
2. **Empty, error, success**: reach each one. An error that leaves an empty dialog, a success with
   two notifications, or an empty state that should have hidden the section are findings.
3. **Long content**: many items, long names, long strings (French and German copy runs longer),
   to check max heights, scroll, truncation, and wrapping.
4. **Theme**: compare light and dark. For a quick check, toggle the `dark` class on the root
   element; confirm with the real theme setting before reporting.
5. **Widths**: mobile (375 px), tablet (768 px), and desktop, plus narrow containers (resize side
   panels, open the conversation side panel) for container-query layouts.
6. **Interactions**: click and keyboard (Enter, Escape, Tab, arrows, space), double-click on submit
   buttons, open then close then reopen dialogs and sheets (state reset), switch tabs in the middle
   of a selection, reload with a draft, navigate back, abandon a multi-step flow halfway.
7. **Regression baseline**: for a visual tweak, compare the same screen on the base branch or
   production before calling it better or worse.

Reset any viewport emulation when done.

## Evidence

- Measure instead of eyeballing when it matters: `getBoundingClientRect()` before and after load
  for shifts and alignment, computed styles for colors, spacing, and radius.
- Read console messages and network requests: key and hydration warnings, request loops, duplicate
  fetches, 4xx responses on page load.
- Zoom screenshots on the affected region and note the exact steps to reproduce.
- Keep screenshots in the conversation. Do not upload them anywhere.

## Reporting

- Each observed problem becomes a finding tagged `ux`, with steps and the observed result.
- Mark what you observed separately from what you suspect. Suspicions you could not exercise stay
  in the "Check in the preview" section with the exact state to reproduce.
- Do not report a visual bug from a stale preview or from a state you forced artificially without
  confirming it in the real flow.
