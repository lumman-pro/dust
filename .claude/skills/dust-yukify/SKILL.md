---
name: dust-yukify
description: Review a front-end pull request, branch, commit, diff, or pending changes against Dust's front-end review bar. Use when the user asks to "yukify", "dust-yukify", run a Yukify review, or audit React, Sparkle, Tailwind, front-spa, viz, or extension UI changes before sending them for review. Produce a read-only, evidence-backed review that looks at what users see first (layout shift, loading and empty states, dark mode, mobile, copy), then React lifecycle discipline, reuse of existing components and constants, Sparkle and Tailwind usage, and readability. Never post review output or mutate anything on GitHub.
---

# `/dust-yukify`: review front-end changes against Dust's front-end bar

Review like a front-end owner who opens the preview before reading the diff: curious,
question-first, picky about anything a user can see, allergic to React ceremony and to markup
nobody needs. Find real UX regressions and front-end inconsistencies. Thoroughness means picturing
every state of the UI and checking the code that produces it, not inventing findings. Approve
readily when the change is fine and leave polish as nits or follow-ups.

`dust-flavify` is the backend counterpart. When the target mixes both, review the front-end files
here and say which backend files deserve a `dust-flavify` pass instead of reviewing them shallowly.

Front-end scope: `front/components/`, `front/hooks/`, `front/lib/swr/`, `front/lib/client/`,
`front/styles/`, `front-spa/`, `sparkle/`, `viz/`, `extension/ui/`, and user-visible strings
anywhere.

## Hard rule: GitHub is read-only

Keep the entire review in the conversation.

Allowed:

- `gh pr view`, `gh pr diff`, `gh pr view --comments`, and other read-only `gh` commands.
- `gh api` GET requests and read-only GraphQL queries.
- Local read-only inspection of git history and repository files.
- Viewing a preview deployment or a local environment in the browser (see Live QA below).

Forbidden:

- `gh pr review`, `gh pr comment`, `gh pr edit`, `gh pr merge`, `gh pr close`, labels, or
  reactions.
- Any POST, PATCH, PUT, or DELETE to GitHub review, issue, PR, reviewer, label, or reaction
  endpoints.
- Slack, email, DM, Figma comments, or another side-channel containing the review.
- Pushing fixes to the author's branch.

If the user later asks to publish the review, stop and confirm in plain language before any write.
Prefer having the user copy the final wording themselves.

## Execution modes

- **Static review** is the default: read the diff and enough surrounding code to picture every UI
  state. Turn each visual suspicion you cannot confirm from code into an entry in the "Check in the
  preview" section.
- **Live QA** is opt-in: run it only when the user asks for it or hands over a preview URL or a
  running environment. Read [`references/ui-qa.md`](references/ui-qa.md) completely before starting.
  Report only what you observed, and keep screenshots local to the conversation.

Do not spawn child agents or parallel hunts unless the user explicitly asks for them.

## Review workflow

### 1. Resolve the target

Use the first applicable target:

1. Explicit PR number or URL:
   - `gh pr view <number> --json title,body,author,files,additions,deletions,baseRefName,headRefName,url,labels`
   - `gh pr diff <number>`
   - `gh pr view <number> --comments` for existing discussion and the preview URL (the
     `<!-- spa-preview-app -->` comment links `https://pr-<number>-merge--app.preview.dust.tt`;
     Sparkle changes also get a Storybook preview).
2. Explicit commit: `git show --stat <sha>` and `git show <sha>`.
3. Provided diff or file paths: inspect them directly.
4. Current branch or pending changes:
   - `git status --porcelain`
   - `git diff` and `git diff --cached`
   - `git log <main>..HEAD --oneline`
   - `git diff <main>...HEAD`

If the target remains ambiguous, ask once and then default to the current branch.

### 2. Load the current canonical rules

- Read the applicable `AGENTS.md` files, `sparkle/AGENTS.md` when Sparkle is touched.
- Read the repository-root `CONTRACTS` and each touched workspace's `CONTRACTS` (`front/CONTRACTS`
  holds the `label:react` and UI text rules). Cite their current rule identifiers in findings.
- Current rules beat the habits in this skill. Example: displayed dates go through
  `lib/i18n/format.ts`, so never suggest a date library for formatting.
- Load the focused skill when its domain is touched: `dust-writing-react-effects` (effects),
  `dust-react-hook-form-writer` (forms), `dust-ux-writing` (non-trivial copy), `dust-i18n` (strings
  in files that use Lingui).
- Before asserting that a Sparkle component accepts or lacks a prop, check the `sparkle-storybook`
  MCP tools when available, otherwise the component source in `sparkle/src/components/`.

### 3. Understand the change before judging it

- Read the PR description, changed files, and existing review conversation.
- Read the parent that renders each changed component, its siblings, and the hooks it calls. A
  margin, a loader, or a memo cannot be judged without its container and its consumers.
- Picture the UI in each state: first render, loading, empty, error, success, long content, dark
  mode, narrow width, feature flag off and on.
- Identify feature-flag gating and whether the surface is already shipped.
- Separate issues introduced by the target from pre-existing code. Mention pre-existing problems
  only when the change touches or relies on them, and say so ("I know it's not your code but...").

### 4. Run the priority passes in order

#### Pass A: what the user sees

This is the highest-yield pass. For each changed surface, walk through every state and flag:

- **Layout shift**: a loader or skeleton whose size or position differs from the loaded content;
  an element that appears when async data arrives and pushes its siblings (prefer rendering it from
  the start, disabled until ready); a composer or input bar that moves.
- **Doubles**: two loaders in sequence, a notification sent by both the hook and the caller, two
  close buttons, two borders, two titles, the same content twice on a page, the same word repeated
  in every option of a menu.
- **Missing or broken states**: an async action without a loading or disabled state
  (`async-network-loading-state`); an error that renders an empty dialog; a busy state that sticks
  when the user abandons a flow (closed OAuth popup); a form that keeps stale values after
  close and reopen; a selection silently lost on tab switch or SWR revalidation; drafts not cleared
  when the user clicks Send instead of pressing Enter.
- **Controls that lie or do nothing**: a disabled look without `disabled`, `clickable` with no
  effect, a tooltip that contradicts the state, a filter with a single option, a section or option
  shown when there is nothing to act on (prefer hiding it over an "empty" sentence), a reused
  composer or menu exposing actions that make no sense on this surface (attachments, human
  mentions).
- **Dark mode**: hardcoded `bg-white` or palette colors that do not flip, invisible spinners or
  borders, dark classes on a page that does not support dark theme.
- **Narrow widths**: padding too tight on mobile, chips or labels overflowing the composer, tab
  lists that do not fit, tables that should hide low-value columns under a container breakpoint,
  `h-screen` where `min-h-screen` is needed.
- **Long content**: lists without `max-h-*` and scroll, a `ScrollArea` placed too low or too high
  so scroll breaks, truncated text with no way to read it, a dropdown whose width jumps while
  searching.
- **Interaction details**: focus after submit, Escape and arrow keys, the whole row clickable
  instead of a tiny radio, links that do not look clickable, text selection broken by overlays,
  resizable panels without `minSize` (collapsing to 0 hides the way back).
- **Motion**: an animation that does not actually run (remove it), animating `gap` or height in a
  way that glitches, entrance durations far above ~300 ms, animation on mount the user did not
  trigger, missing reduced-motion handling.
- **Visual consistency**: spacing that does not align with the header or neighbors, icons that
  siblings do not have or whose meaning misleads (a lock reads "private"), nested radius
  mismatches, button variants that differ side by side, sizes heavier than the surrounding UI.

#### Pass B: React lifecycle discipline

- **Memoization**: keep `useMemo`/`useCallback` only when the value is a hook dependency, a prop
  of a `React.memo` child, a Context value (`stable-context-values`), or measurably expensive.
  Callbacks returned from custom hooks must stay wrapped since consumers cannot know their
  stability. Flag memos whose dependencies change every render (a streamed message object, an
  inline array, a whole context object) and suggest depending on derived primitives instead.
  Memoizing JSX built from unmemoized `children` buys nothing.
- **Effects**: an effect reacting to a user event belongs in the handler (`onOpenChange`,
  `onClick`, `onSubmit`, `onClose`). An effect copying props into state is derived state. Two
  effects with identical dependencies are one effect. State set only to trigger another effect is
  an event in disguise. An effect that exists only for its cleanup (`useEffect(() => stop, [stop])`)
  reads as "run on mount"; ask for a name or a comment. Apply `dust-writing-react-effects`.
- **Measurement**: treat `useLayoutEffect`, `ResizeObserver`, and manual DOM measurement as
  suspicious. Ask why CSS (flex, grid, container queries, `display: contents`) or an existing
  component (Collapsible, TruncatedText) does not do it.
- **Refs as crutches**: refs mirroring callbacks "to avoid re-subscribing" when the source is
  already stable (read the hook to verify), ref flags orchestrating effects, busy flags kept in a
  ref instead of one handler with `try`/`finally`.
- **Remounts**: components declared inside components, render helpers that return JSX and are
  called as functions, capitalized factories called during render. They remount or recreate on
  every render; move them to module-level components.
- **State**: never mutate state; use the updater form when the next state depends on the previous
  one; do not seed state with a lie (`{} as X`), use a module-level default plus a loading state;
  question a single large state object whose fields change independently; make local vs server
  state obvious from names. Use `useReducer(reducer, arg, init)` instead of a memoized initial
  object.
- **Render purity and cleanup**: no side effects during render (logging, tracking); no module-level
  caches that are never cleared; clear timeouts and remove listeners on unmount.
- **Hooks and props**: pass `owner`, `user`, and permissions down consistently instead of reading
  context in a leaf or nesting a context hook inside a utility hook; a "hook" that only computes from
  its arguments is a plain function memoized at the call site; a provider every new page must
  remember belongs in the layout.
- **SWR** (`network-operations-in-swr-hooks`): use the `disabled` option rather than a `null` key,
  return `emptyArray()` and a false loading flag when disabled, send notifications from the hook.
  Question cache options in both directions: rarely changing data can dedupe longer, live data must
  still revalidate. Flag refetches that overwrite in-progress local edits.
- **Exhaustiveness**: `assertNeverAndIgnore` for API data
  (`client-exhaustiveness-tolerates-new-values`).
- **Keys**: use a keyed `Fragment` instead of a wrapper `span` that exists only to carry a key.

#### Pass C: reuse and single source of truth

- Before accepting a new component, hook, helper, or loading pattern, search for the existing one
  with `rg`, by behavior and not only by name. Typical misses: Sparkle `Label`, `Icon`,
  `DialogContainer`, `Collapsible`, `TruncatedText`, `DataTable`, `ContextItem`, `EmptyCTA`,
  `LoadingBlock`; front `InfiniteScroll`, `useDebounce`, `useWorkspacePermissions`,
  `useCopyToClipboard`, plan and permission helpers, `lib/i18n/format.ts`; the loading or empty
  state another page already uses for the same layout.
- Flag parallel implementations: near-identical components, the same fallback in several files, two
  hooks that differ only by endpoint, logic duplicated between the conversation UI and the agent
  builder ("can we share it with X?").
- Flag constants defined in more than one place: allowed hosts, page sizes and limits, default
  periods, max sizes duplicated across routes, accepted file types in an `accept` attribute vs the
  backend validation, a max count enforced by both a form and the API. Prefer one exported constant.
- Keep spacing owned by one place. When a list or layout already computes margins centrally, new
  items go through it instead of adding `mt-*`/`py-*` locally. A skeleton and the page it stands in
  for share one layout wrapper so a style tweak cannot desync them.
- Move static arrays, objects, strings, URLs, and size tokens out of components and hooks to module
  level. A module-level size constant also stops anyone from passing a different size.
- Do not export a constant that callers should not use directly.
- Put a component in Sparkle only when it is obviously reusable; promote it once a second consumer
  exists. Keep experimental or playground components out of `src/components/` where agents will
  pick them up.

#### Pass D: Sparkle, Tailwind, and markup

- **Theme tokens**: no new `dark:` variants or legacy `-night` tokens. Semantic tokens flip through
  `tokens.css`; ask whether the light token already works in both themes, and add a semantic token
  when it does not. When a `dark:` variant is unavoidable, keep the variant order consistent
  (`dark:hover:`).
- **Arbitrary values**: question `mt-[3px]`, `rounded-[15px]`, `max-w-[480px]` when a scale value or
  proper alignment fixes it. Accept with a reason (multi-line alignment).
- **Where styles live**: no inline `style` when a class works (harder to override), no
  `<style jsx>`, no global CSS overriding component styles (keep the classes in the component; global
  CSS is for generic, top-level, or third-party styling), no Sparkle internals restyled from front,
  no `!important` (`no-css-important`).
- **Sparkle usage**: verify every prop exists (a hallucinated prop silently does nothing); drop
  props equal to the default; use variants and props (`align="end"`) instead of overriding a Sparkle
  component's padding, width, or colors; when the design needs a new look, raise it as a design
  question instead of a one-off override.
- **Markup**: "so many divs": remove wrappers whose classes the child can take, spacer divs
  (`<div className="h-4" />`, use `gap`), and cargo-cult utilities (`h-full`, `min-h-0`,
  `relative`, `overflow-*`, `w-full`, `flex-grow` on a non-flex parent). Use `divide-y` instead of
  index-based borders, `cn` for conditional classes but not on one static string or nested inside
  another `cn`.
- **Semantics and accessibility**: a form label is a `Label` with `htmlFor`, not a heading; an
  option group is `fieldset`, `legend`, and radios; do not nest `Label` inside `label`; `role` and
  `aria-*` scoped to the right element; `inputMode`/`type` that fit the value; no `onClick` on a
  plain `div` without a reason; tooltips on non-button triggers use `tooltipTriggerAsChild`.
- **Fragile detection**: branching on `className.includes(...)` or DOM structure breaks silently;
  prefer props or data.
- **Assets**: SVG or WebP for logos, no spaces in file names, no font or CSS bundle the surface does
  not need, check bundle size for heavy new dependencies.
- **Viz and Frames**: declare repeated colors as tokens in viz CSS instead of raw `oklch(...)`
  everywhere; remember `dark:` may not apply there.

#### Pass E: copy and product semantics

- **Typographic apostrophe**: user-visible English uses `’` (don’t, you’re, frame’s). Check that a
  formatter or a rewrite did not turn an intentional `’` back into `'`.
- **Product vocabulary**: use the words the UI already uses; internal names (grants, promote,
  canonical, a feature's former name) do not belong in copy. Keep product nouns and sentence case
  consistent within a surface.
- **Accuracy**: copy must match behavior: the tooltip of a disabled control, accepted file formats
  vs the `accept` list, an error that claims more than the check enforces, a "Resend code" that
  navigates back.
- **Concision**: drop redundant words ("immediately"), a phrase every option repeats, a description
  that restates its title, a notification that repeats an inline message.
- **Punctuation**: no trailing `...` in placeholders unless established, consistent periods across
  a list, `?` on questions, no space before a colon, no double spaces, no "etc" after a single
  example.
- **Plurals and i18n**: one message per sentence with `plural`/`select` (`dust-i18n`), no
  concatenation (`ui-text-not-concatenated`, `translated-files-stay-translated`), no global `i18n`
  in components, locale from `useLingui` passed to formatters, raw error messages never shown
  (`ui-errors-through-format-error`), proper nouns and tool names left untranslated.
- **No emoji in product UI**; use an icon.

#### Pass F: readability

- **Naming**: no single-letter callback params; functions start with a verb (`getKeyId`); a name
  starting with `is`/`has` holds a boolean; names describe meaning, not mechanism
  (`isCustomAgent` over `allowReactions`, `removeFromPanelHistory` over `forgetPanels`); prefixes
  that matter come first (`unsafeFetch...`); flags phrased positively so call sites do not flip them
  with `!`; no method sharing a name with the function it wraps; file names follow renamed
  concepts.
- **Components and props**: props typed with an `interface` (`component-props-interfaces`); named
  `function` components rather than anonymous arrows; explicit parameters rather than
  `{ recipient, ...payload }` blends; types derived from existing domain types.
- **Control flow**: early returns or an extracted component instead of nested ternaries or IIFEs;
  constants computed above the `return` instead of logic inside JSX; named handlers instead of long
  inline closures; a `Record<Kind, Config>` lookup instead of extra label parameters; a config
  array mapped once instead of repeated JSX blocks; `matchAll` over manual `exec` loops; `.some`
  over `filter(...).length`; sort or derive once instead of on every render.
- **Types**: no `any`, no `as` (`no-unsafe-type-assertions`), no `as const` on a boolean, no
  `!!` on a boolean, no `?? ""` that cannot trigger, mutually exclusive props as a discriminated
  union, one representation per value (not both `"14d"` and `14`).
- **Comments**: delete comments that restate code, label sections (`{/* URL section */}`), cite
  Figma, narrate history (`// From black`), or repeat a signature in JSDoc; fix comments that
  contradict the code; ask for a comment where logic is genuinely non-obvious (timers, keyboard
  handling, URL hash surgery, an intentional dependency omission); ask whether old TODOs are done.
  A `@cc` contract on a styling detail is noise; one on a product invariant is welcome.

#### Pass G: agent-written code and hygiene

Most PRs are partly agent-written; name the patterns plainly and without blame.

- Ref and effect orchestration, defensive `useCallback`/`useMemo` everywhere, verbose comments,
  measurement code, animations that never ran, one-off SVG icons when the icon set has one,
  instruction text with invented numbers ("where does this 0.3 s to 0.5 s come from?").
- Leftovers: `console.log`, debug indicators, commented-out code and imports, unused components,
  stories, props, exports, or constants (`const isLoading = false`), rebase leftovers, stray blank
  lines.
- Unrelated churn: lockfile or SDK version bumps, a manual Sparkle version bump (Sparkle is bumped
  and published from GitHub Actions), formatting changes outside the change.
- Rollout: risky user-facing changes behind a flag, flags kept after release, an unreleased surface
  made obvious to whoever can reach it, PostHog tracking removed by accident.

### 5. Audit the PR description proportionally

For a visual change, ask for before/after screenshots or a short video, the states tested (dark
mode, mobile, empty, error), and the flag gating. Do not require them for refactors with no visual
impact, and do not complain about empty template sections on trivial fixes.

### 6. Verify every finding

- Search for the existing primitive before saying it exists.
- Read the hook before claiming a callback is unstable or a memo is useless.
- Read the parent before claiming a class or wrapper does nothing.
- Quote the exact line when the issue is not obvious.
- Tie each `BLOCKER` to a current rule or a concrete user-facing failure.
- If evidence is incomplete, write an `OOC` question or a "Check in the preview" entry rather
  than asserting a defect.

## Severity and verdicts

- `BLOCKER`: the change breaks or regresses a shipped flow (feature does nothing, data or existing
  content lost, empty dialog, broken scroll, unreadable dark mode, unusable mobile layout, double
  side effects), a prop or variant that silently does nothing on the critical path, or a material
  violation of a current `MUST` rule.
- `SHOULD`: layout shift or flicker, React lifecycle misuse with a real cost (remounts, effect
  chains, self-defeating memo), duplicated constants or components, new `dark:` variants or
  arbitrary values, a missing loading state.
- `nit`: copy polish, naming, a useless memo or callback, wrapper divs, comments.
- `OOC`: a question whose answer may change the verdict.
- `Follow-up`: worth doing but outside the PR ("not related to your PR but...").
- `PRAISE`: only genuinely clean or user-visible improvements. Never praise the existence of the PR,
  and never praise visual behavior (no layout shift, smooth animation) you have not observed in the
  running app.

Calibrate on rollout: a surface behind a feature flag that is not rolled out (for example
`dust_only`) gets `SHOULD` at most for problems only flagged users can see. Keep `BLOCKER` for data
loss, security, or impact on users without the flag.

Choose:

- `REQUEST_CHANGES` when at least one `BLOCKER` remains.
- `APPROVE_WITH_NITS` when no blocker remains but there are actionable `SHOULD` or `nit` findings.
- `APPROVE` when there is no actionable feedback.

This review style approves to unblock and lists polish as nits or follow-ups. Do not inflate
visual taste into a blocker; route taste questions to design as `OOC`.

## Output format

Produce the report inline:

```markdown
# Yukify Review: <target>

**Verdict:** APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES

**Summary:** <actual change and the one or two most important observations>

## Blockers
- **`BLOCKER`** [`file:line`] `ux` <terse finding, evidence, rule if any, concrete direction>

## Shoulds
- **`SHOULD`** [`file:line`] `react` ...

## Nits
- **`nit`** [`file:line`] `copy` ...

## Open questions
- **`OOC`** [`file:line`] ...

## Check in the preview
- <state to reproduce> -> <what to look for>

## Follow-ups
- <out-of-scope improvement worth a separate PR>

## Praise
- **`PRAISE`** [`file`] ...

## PR description audit
- <only material checks for this PR>

## Final note
<one terse sentence>
```

Tag each finding with one category: `ux`, `react`, `reuse`, `style`, `copy`, `readability`,
`hygiene`. Omit empty sections. Include a surgical `suggestion` block when it is clearly correct,
including copy rewrites.

Write each finding like a PR comment, not an essay: one or two sentences, problem or question
first, evidence in one clause, the fix in the `suggestion` block. Past about 60 words, cut or split
it. Keep the Summary to two sentences and the "Check in the preview" entries to one line each.

## Tone

- Ask when intent is uncertain instead of asserting, and grade pickiness honestly (`nit`).
- Say when an issue is pre-existing or out of scope, and offer the alternative, not just the
  objection.
- Say "looks good" when it is; leave polish as nits or follow-ups.

## Quick reference

Scan in this order:

1. In every state (loading, empty, error, long, dark, narrow), does anything shift, flicker,
   double up, overflow, or stop working?
2. Does every async action show a loading or disabled state, and does every control do what it
   looks like it does?
3. Is each `useMemo`/`useCallback`/`useEffect`/`useRef`/`useLayoutEffect` earning its place?
4. Is anything remounting every render (inner components, render helpers, IIFEs)?
5. Is there an existing component, hook, helper, constant, or loading pattern for this?
6. Is any constant, limit, or spacing rule now defined in two places?
7. Any new `dark:`, `-night`, arbitrary value, inline `style`, global override, or `!important`?
8. Does every Sparkle prop exist, and is the component used rather than overridden?
9. How many divs can go? Are labels, headings, and option groups semantic?
10. Does the copy use `’`, product vocabulary, consistent punctuation, and say what the UI does?
11. Are i18n, date formatting, and error display following current contracts?
12. Are names, props interfaces, and control flow easy to read? Any `any`, `as`, `!!`, `as const`?
13. Any comment to delete, fix, or add?
14. Any leftovers, unrelated churn, removed tracking, or flag gap?
15. Does the PR description show what it looks like and what was tested?

When the scan is clean, complete the relevant review and approve. Never invent a nit to avoid an
empty report.
