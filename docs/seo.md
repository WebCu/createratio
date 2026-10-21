# Website search quality

SEO has two jobs: keep useful pages discoverable, and learn which real user
questions the site should answer. Passing CI prevents technical regressions;
it does not prove indexing, rankings, or traffic growth.

## Every website PR

The author identifies affected URLs and the user question being answered.
A maintainer reviews accuracy and usefulness, not keyword density. For changes
intended to improve search performance, include one hypothesis, a baseline,
and a review date in the PR. Mark unrelated changes as not applicable.

- Keep one descriptive title, a unique description, one primary heading, and
  an absolute self-canonical on each published page. The homepage canonical is
  `https://createratio.com/`, not `/index.html` or the www hostname.
- Keep essential content and installation links in HTML without JavaScript.
  Use language users understand; avoid keyword stuffing, duplicate landing
  pages, unsupported product claims, and invented reviews or ratings.
- Keep homepage Open Graph and Twitter text aligned with search metadata.
  `WebSite` JSON-LD identifies the site; it does not promise a rich result.
- When adding or removing a page, update `site/build.js`, the public allowlist
  in `site/dev-server.js`, Docker mounts, and `site/sitemap.xml`. Use only
  canonical URLs in the sitemap. Do not stamp a fresh `lastmod` on every build;
  omit it unless a meaningful content-modification date can be maintained.
- Preserve working internal links, keyboard/mobile access, reduced motion,
  and fast delivery. Follow the [website checks](testing.md#website).

Run the focused SEO gate with `node --test site/tests/seo.test.js` and the full
`pnpm check` before merging. Existing PR CI runs these tests automatically.
The tests check built-page metadata, canonical and sitemap coverage, static
site identity/social metadata, and GET/HEAD delivery of crawl files in source
and built previews. They do not evaluate content quality or the live CDN.
A repository owner should require the existing CI `test-and-build` check in
main's branch protection/ruleset; running CI alone does not prevent a bypass.

## After deployment

The releasing maintainer checks `/`, `/privacy.html`, `/terms.html`,
`/robots.txt`, and `/sitemap.xml` on `https://createratio.com`: successful HTTP
responses, correct content types, no unexpected redirects, and no `noindex`
HTML or `X-Robots-Tag` response header. Confirm the www hostname redirects to
the canonical hostname and a nonexistent page returns 404, not the homepage.
Inspect the deployed canonical and JSON-LD, not just the local source.

An owner with access must verify the `createratio.com` Domain property in
Google Search Console and submit `https://createratio.com/sitemap.xml` once.
Check URL Inspection for crawl access and Google's selected canonical after
material changes. Keep verification credentials and private reports out of Git.
These are operator checks, not assumed completed by a source change.

## Monthly learning loop

The site maintainer owns a monthly review and keeps Search Console issue email
alerts enabled. Record the baseline when setting up access. Compare the latest
complete 28 days with the preceding 28 days, segmented by page and query; separate
branded from non-branded searches. Track impressions, clicks, CTR, average
position, indexed pages, and Core Web Vitals when enough field data exists.
Missing or low-volume data is not a pass or evidence of a trend.

Choose one evidence-backed improvement per cycle: fix indexing errors first;
then answer a relevant query that is already getting impressions, improve an
unclear search snippet, or fix a measured usability/performance problem.
Do not create thin pages merely to cover keywords. Each follow-up issue records
the URL, query/user need, baseline/date range, proposed change, expected signal,
and review date at least 28 days after deployment. Check whether Google has
recrawled it before judging the result. Traffic changes are observational,
not proof that one PR caused them; retain, revise, or revert based on evidence.

## References

- [Google: canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google: sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: site-name structured data](https://developers.google.com/search/docs/appearance/site-names)
- [Google: using Search Console](https://developers.google.com/search/docs/monitor-debug/search-console-start)
