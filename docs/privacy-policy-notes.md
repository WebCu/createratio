# Terms and privacy policy maintenance

[`site/privacy.html`](../site/privacy.html) and
[`site/terms.html`](../site/terms.html) are the canonical legal pages. Website
builds and previews serve both; extension Settings links to their publicly
hosted versions.

## Scope

Keep the policy focused on information handled, purposes, recipients, retention,
privacy choices, rights, and contact details. Describe creation tracking,
optional website time, and saved intentions accurately, including local-only
storage and deletion limits. Product tutorials and implementation details belong
in the [extension documentation](../extension/README.md) and
[website documentation](../site/README.md#analytics), not the policy.

The terms distinguish the MIT software license from official services. Preserve
commercial reuse, modification, and redistribution rights; do not add a
noncommercial restriction or mandatory publication of modifications. The
[project principles](../CONTRIBUTING.md#project-principles) keep the extension
and future improvements free and open source. Optional future paid or cloud
services are not current features and must not be described as active billing
or data flows. Do not invent a payment provider, subscription, age gate,
liability cap, arbitration process, or chosen jurisdiction.

Publisher verification, legal-review records, account configuration, and
deployment approvals belong in private records outside this repository.

## Sources and attribution

Adapted from General Legal's CC0 [U.S.](https://github.com/General-Legal/legal-templates/tree/6d6805425eabd41bed86fc1e2ec51612760f716c/templates/privacy-policy-us),
[GDPR](https://github.com/General-Legal/legal-templates/tree/6d6805425eabd41bed86fc1e2ec51612760f716c/templates/privacy-policy-gdpr),
and [cookie guidance](https://github.com/General-Legal/legal-templates/tree/6d6805425eabd41bed86fc1e2ec51612760f716c/templates/cookie-notice),
pinned to `6d6805425eabd41bed86fc1e2ec51612760f716c`.
[CC0](https://github.com/General-Legal/legal-templates/blob/6d6805425eabd41bed86fc1e2ec51612760f716c/LICENSE)
permits adaptation without requiring attribution. Credit is recorded here rather
than on the policy page. General Legal has not reviewed the adapted policy;
no attorney-client relationship is established.

Provider disclosures reference:

- [Plausible's data policy](https://plausible.io/data-policy) and
  [retention information](https://plausible.io/#pricing).
- [AWS data privacy information](https://aws.amazon.com/compliance/data-privacy-faq/).
- [Google's Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum)
  and [Workspace terms](https://workspace.google.com/terms/premier_terms.html).

## Verification

When data handling changes, update the policy and applicable store disclosures.
Run `pnpm check` to check legal-page content, website delivery, and extension
links. Before publication, review the wording and verify that
`https://createratio.com/privacy.html` and
`https://createratio.com/terms.html` serve the intended pages over HTTPS.
Automated checks do not establish legal compliance; qualified legal review is
needed for enforceability, applicable privacy duties, and future paid offerings.
