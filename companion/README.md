# Browser companion

Reports the focused window's active tab to the GNOME Screen Time extension so
browser time breaks down by site (activity) and a site unit (detail), for
example `github.com / anthropics/claude-code`.

## What leaves the browser

Only `{browser, host, detail}`. The browser id is a build-time constant from the
generated `browser-id.js`; `host` and `detail` are computed in `webext/rules.js`:

- `browser`: `brave`, `chrome`, `firefox` or `zen`, a build-time constant.
- `host`: hostname, lowercased, one leading `www.` removed.
- `detail`: the site unit, taken from the path only:
  - `owner/repo` on github.com, gitlab.com, codeberg.org, bitbucket.org,
    git.sr.ht and gitea.com
  - the article on `*.wikipedia.org`, `*.wiktionary.org`, `*.wikiquote.org`
  - the package on npmjs.com, pypi.org, crates.io and rubygems.org; a scoped
    npm package keeps its scope (`@babel/core`)
  - the project key on `*.atlassian.net`, from `/browse/KEY-1` or
    `/jira/<product>/projects/KEY/...`
  - the team prefix of an issue on linear.app (`/acme/issue/ENG-12` -> `ENG`)
  - on every other host, and on any host above whose path does not match
    its rule, the first path segment, shaped by three adjustments:
    - a leading run of dates is skipped
      (`/2026/09/21/technology/...` -> `technology`); a path of nothing but
      dates reports them whole (`/2026/09/21`);
    - a locale is kept as its language and the rest of the path is read the
      same way after it, so regional forms share one row
      (`/en-US/docs/...` and `/en/docs/...` -> `en/docs`). A locale is one
      of a fixed list of common language codes, optionally with a country,
      script or region (`ja`, `pt-BR`, `zh-Hans`, `es-419`);
    - any other segment of one or two characters is a routing prefix and
      takes exactly one segment with it: `/r/<sub>` -> `r/<sub>` (reddit
      needs no rule of its own), `/nz/iphone` -> `nz/iphone`,
      `/dp/<ASIN>` -> `dp/<ASIN>`.

    A default detail is at most three segments. Host rules above read their
    segments raw, so a two-letter repo owner and an article named for a year
    survive.

  Segments are URL-decoded and cut at 64 characters.

Private windows and non-web schemes send empty strings. An unfocused browser still sends its site with `focused: false`; the Shell shows it in preferences but credits time only while focused.
The URL, title, query string and fragment never leave the browser.

## Contract

The native host (`host/screen-time-host.js`, gjs) calls, on the session bus:

    destination  org.gnome.Shell
    object       /org/gnome/Shell/Extensions/ScreenTime
    interface    org.gnome.Shell.Extensions.ScreenTime
    method       ReportActiveTab(s browser, s host, s detail, b focused) -> ()

    method       GetCompanions() -> a(ssbb)   (browser, current site, connected, focused)
    signal       Ready                        emitted on enable; hosts resend their last report

Empty `host` means no breakdown. The extension watches the caller's unique
bus name and clears that browser's state when it vanishes, so closing the
browser ends the breakdown immediately. The host answers `{"ping": true}`
on stdin with `{"pong": true}` on stdout; `make companion-install` uses this
as a smoke test.

## Install

    make companion-build      # dist/webext-brave/, dist/screen-time-brave.zip, dist/screen-time-zen.xpi
    make companion-install    # host manifests for Brave and Zen, pointing at this checkout

Brave: `brave://extensions`, enable Developer mode, Load unpacked,
choose `dist/webext-brave`. Chrome: the same at `chrome://extensions` with
`dist/webext-chrome`. The manifest carries no signing key, so Chromium derives
each build's id from its absolute directory path; `make companion-install`
derives the same id the same way and writes it into the host manifest. Moving
or renaming the checkout changes both, so re-run `make companion-install` and
reload the unpacked extension. A store-published build gets its key, and a
permanent id, from the store.

Zen: `about:config`, set `xpinstall.signatures.required` to `false`, then
open `dist/screen-time-zen.xpi`. If Zen ignores the pref (release builds of
Firefox do), load it temporarily from `about:debugging` for testing; a signed
build through AMO's unlisted channel is the permanent route. For that fallback
pick `dist/webext-zen/manifest.json`, the unpacked Zen build.

`make companion-uninstall` removes the host manifests. Remove the extension
from the browser separately.
