# Tools Website — static site skeleton (Phase 1)

Free online tools website: file-in / exact-file-out tools (photo & signature sizing for
exam/job forms, exact-KB image compression, Urdu tools, creator tools, file converters).
Plain HTML/CSS/JS only — **no build step, no frameworks, no npm**. Hosted on Netlify
straight from this folder (see `netlify.toml`: publish = ".", no build command).

## ⚠️ Temporary / placeholder items — replace before real launch

1. **Brand name:** "Tools Website" is a *working name only* (final name not chosen yet).
   It appears in each page in two obvious places: the header logo
   (`<a class="logo" ...>Tools<span>Website</span></a>`) and the `<title>` tag,
   plus footer/JSON-LD mentions. A find-and-replace of `Tools Website` / `Tools<span>Website</span>`
   across the folder updates everything.
2. **Sitemap base URL:** `sitemap.xml` and `robots.txt` use the placeholder
   `https://example.com/`. When the real domain is connected, replace
   `https://example.com` with the real base URL in both files.
3. **Contact email:** `contact/index.html` uses `contact@example.com` (mailto + form
   action). Replace with the real address once email is set up on the domain.
4. **Tool pages:** the 8 pages under `tools/` are content placeholders describing each
   Phase 1 tool (the interactive tools are built in Phase 2). Phase 2/3 tools appear as
   "Coming soon" cards with no links.

## Structure

```
index.html                  Homepage: hero, tool search, popular tools, categories, trust strip, FAQ (+ JSON-LD)
assets/style.css            Single shared stylesheet (mobile-first, dark mode via [data-theme="dark"])
assets/app.js               Dark-mode toggle (localStorage) + homepage tool search filter
image-form-tools/           Category: compress/resize/passport/background tools
urdu-tools/                 Category: Urdu OCR, voice to text, transcript (coming soon)
creator-tools/              Category: YouTube/Instagram/WhatsApp tools (coming soon)
file-converters/            Category: image to PDF, converters, dev utilities
tools/<tool-slug>/          One folder per Phase 1 tool (8 placeholder pages)
about/  contact/  privacy/  terms/  disclaimer/     Mandatory pages (AdSense/trust)
sitemap.xml                 All built pages (placeholder base URL — see above)
robots.txt                  Allow all + sitemap reference
netlify.toml                Netlify: publish ".", no build command
```

## Run locally

```bash
cd tools-website
python3 -m http.server 8000
# open http://localhost:8000
```

## Conventions

- All internal links are **relative** (no domain baked in), so the site works on
  Netlify previews, localhost, and the future custom domain unchanged.
- Every page: semantic HTML, unique `<title>` + meta description, shared header/footer.
- Category and tool pages carry BreadcrumbList JSON-LD; the homepage carries
  Organization + WebSite + WebApplication + FAQPage JSON-LD.
