# CreateRatio

<!-- impeccable:product-schema 1 -->

Shared product context for the website in `site/` and browser extension in
`extension/`. Detailed behavior lives in their guides; terminology lives in
[GLOSSARY.md](GLOSSARY.md), and project commitments in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Platform

web

## Users

Anyone who wants to create more than they consume online. There is no narrower
professional or demographic audience. Site integrations support X, LinkedIn,
and opt-in, tracking-only TikTok without an access gate.

## Product Purpose

Help people create more than they consume overall. Intentional access and a daily
creation score support that outcome; reducing browsing alone or maximizing a
score is not the goal.

The website explains the product and helps visitors install it. The extension
supports intentional browsing and shows the balance between creating and
consuming.

## Positioning

CreateRatio combines a deliberate pause before site access, configurable
active-time budgets, and local creating-versus-consuming measurements. It is a
personal focus tool, not tamper-proof enforcement or a measure of creative
quality.

## Operating Context

- The static website provides Chrome and Firefox store links, source-install
  instructions, and privacy and terms pages. Edge is available as a source build,
  not a published store release.
- On gated sites, users write an intention, wait, and explicitly confirm access.
  Active-time budgets pause when users switch away. Users can change session
  durations or turn a site's **Limit & track** off.
- The popup shows today's score and access controls; Settings owns preferences;
  the dashboard provides history, charts, and exports.
- Users must save drafts before installation or access expiry: open gated-site
  tabs redirect to the blocked page.

## Capabilities and Constraints

- Creation tracking measures supported creating/consuming time and actions on
  enabled vetted sites. A score is an approximation, not proof of publication
  or productive work. Preserve the measurement limitations in
  [extension/README.md](extension/README.md#measurement-and-score).
- **Website time** is a separate, optional domain/time overview. It does not
  classify creation or consumption, affect the creation score, or gate access.
- Intention saving is optional and off by default, as is Website time.
- Extension records stay in the local browser profile. No forced accounts,
  analytics, telemetry, activity uploads, advertising, or behavioral profiling.
  The website has separate, disclosed analytics; do not conflate the two.
- Extensions and future improvements stay free and open source under MIT.
  Donations or separate optional paid offerings must not weaken that commitment
  or privacy. No paid offerings are currently provided.
- Users control optional functionality and enabled sites. Integrations require
  review and an extension release; arbitrary domains and user scripts are not
  accepted. Tracking support alone does not imply access gating.
- Prefer built-in capabilities and minimal dependencies. Tracking must not slow
  browsing or unnecessarily consume memory, CPU, or battery.

## Brand Commitments

The product name is **CreateRatio**; the existing tagline is **Create > Consume.**
The access gate keeps its cheeky voice while remaining supportive and playful.

## Evidence on Hand

- [README.md](README.md), the [extension guide](extension/README.md), and the
  [website guide](site/README.md) describe capabilities and limitations.
- `site/index.html` contains an explicitly illustrative activity example, not
  personal data or evidence of user outcomes.
- Automated tests and browser journeys verify bounded technical behavior, not
  effectiveness claims. Do not invent testimonials, adoption figures, or
  productivity results.

## Product Principles

1. Help people create more than they consume, rather than maximize engagement.
2. Keep users in control; intentional friction supports choices, software delays
   do not.
3. Preserve privacy and minimize permissions and collected data.
4. Keep the free, open-source extension lightweight and simple; improve existing
   functionality before adding features.
5. Explain measurements honestly, keeping creation tracking, access limits, and
   Website time distinct.

## Accessibility & Inclusion

Preserve keyboard navigation, narrow-layout usability, and reduced-motion
support. Website content, legal pages, and installation links must remain usable
without JavaScript. Verification requirements live in
[docs/testing.md](docs/testing.md).
