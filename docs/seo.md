# Website metadata and crawlability

Keep public pages identifiable, linkable, and readable by browsers and crawlers.

## Every website PR

- Keep one descriptive title, a unique description, one primary heading, and
  an absolute self-canonical on each published page. The homepage canonical is
  `https://createratio.com/`, not `/index.html` or the www hostname.
- Keep essential content and installation links in HTML without JavaScript.
  Use clear language and verified product claims.
- Keep homepage Open Graph and Twitter text aligned with page metadata.
  Static `WebSite` JSON-LD identifies the site.
- When adding or removing a page, update `site/build.js`, the public allowlist
  in `site/dev-server.js`, Docker mounts, and `site/sitemap.xml`. Use only
  canonical URLs in the sitemap. Omit `lastmod` unless a meaningful
  content-modification date can be maintained.
- Preserve working internal links, keyboard/mobile access, reduced motion,
  and fast delivery. Follow the [website checks](testing.md#website).

Run `node --test site/tests/seo.test.js` for the focused checks and `pnpm check`
before merging. Existing PR CI runs these tests automatically. They verify
built-page metadata, canonical and sitemap coverage, static site identity/social
metadata, and GET/HEAD delivery of crawl files in source and built previews.
They do not prove live CDN behavior.

## After deployment

Check `/`, `/privacy.html`, `/terms.html`, `/robots.txt`, and `/sitemap.xml` on
`https://createratio.com`: successful HTTP responses, appropriate content types,
no unexpected redirects, and no unintended `noindex` HTML or `X-Robots-Tag`
response header. Confirm the www hostname redirects to the canonical hostname
and a nonexistent page returns 404, not the homepage. Inspect the deployed
canonical and JSON-LD, not just the local source.

## References

- [Google: canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google: sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: site-name structured data](https://developers.google.com/search/docs/appearance/site-names)
