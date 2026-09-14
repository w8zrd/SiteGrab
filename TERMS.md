# sitegrab — Acceptable Use & Responsibility

sitegrab is a personal tool for downloading offline copies of websites.

## By using this tool you confirm that:

- You own the site you are archiving, **or** you have the explicit permission
  of the site owner to copy it.
- You will not use this tool to copy, redistribute, or republish content you
  do not have the rights to.
- You take full responsibility for the URLs you submit and for whatever you
  do with the resulting archive. The operator of this tool bears no
  responsibility for misuse.

## How this tool behaves

- It identifies itself honestly with a real crawler User-Agent (not a
  spoofed browser identity).
- It respects each site's `robots.txt`. If a site disallows crawling, the
  archive will fail — that's intentional, not a bug.
- It does not attempt to bypass CAPTCHAs, bot-detection challenges, paywalls,
  logins, or any other access control.
- Every archive request is logged (URL, timestamp, requesting IP) for
  accountability.

## Not legal advice

Copyright law and terms-of-service around scraping vary by jurisdiction and
by site. This tool does not determine whether a given use is lawful — that
judgment, and the responsibility for it, is yours.
