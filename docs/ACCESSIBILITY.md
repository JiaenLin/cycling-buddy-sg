# Accessibility target and verification matrix

Cycling Buddy SG targets **WCAG 2.2 Level AA** for the complete responsive page. Accessibility is a
release requirement, not an optional polish pass. Automated axe checks, keyboard/focus assertions,
24 CSS-pixel target checks and reduced-motion checks block release.

## Supported matrix

| Surface | Automated every PR | Manual requirement for affected runtime releases |
|---|---|---|
| Desktop Chromium | Axe WCAG 2.0/2.1/2.2 A+AA, keyboard, focus trap/return, responsive overflow | Windows keyboard-only and 200% zoom |
| Desktop Firefox | Deterministic functional suite; WCAG DOM rules are blocked in pinned Chromium | Keyboard-only spot check |
| Mobile Chromium | Pixel 7 emulation, touch targets, responsive layout, axe | Current physical Android Chrome, TalkBack for changed flows |
| Mobile WebKit | iPhone 13 emulation and responsive functional suite | Current physical iPhone Safari, VoiceOver for changed flows |
| Motion/contrast | Reduced-motion CSS assertion and axe contrast rules | Light/dark/high-contrast visual review for affected components |

The release report records exact devices, operating-system/browser versions and tester. Emulation is
not presented as a substitute for required physical Android/iOS evidence on Tier 3 runtime changes.

## Keyboard and dialog contract

Every operation has a keyboard-reachable control with a visible focus indicator. Modal sheets move
focus inside, trap Tab/Shift+Tab, close with Escape, return focus to the opener, and are inert and
hidden from the accessibility tree while closed. Dynamic update availability is announced politely
and never activates without the rider's action.

## Known exceptions and roadmap

The MapLibre canvas is exposed as a named map region, but individual rendered geographical features
are not separate accessibility-tree objects. Core nonvisual tasks remain available through named
controls, route directions, status text, layer controls and exported GPX. A future native app or
outdoor platform must add a structured nearby-feature and route-step representation rather than
attempting to make canvas geometry itself screen-reader navigable.

Basemap labels originate from a third-party vector style and are not included in the app's WCAG
conformance claim. This exception does not cover first-party controls, dialogs, route directions,
weather warnings or recording status.

## Commands

```text
npm run verify:accessibility
npm run verify:browser
```

No release may suppress an axe violation without adding a documented exception here, owner approval,
an issue/remediation date, and a focused regression test.
