# Secret Key Generator

Port of the standalone Python/Tkinter tool (`Secret Key Generator.pyw`) to a WICKED
module. Pure renderer — no main-process code.

Behavior carried over exactly:

- Length 8–128 (clamped), default 32; bytes for Hex/Base64, characters for
  Alphanumeric; UUID v4 ignores it.
- Generating a key also copies it to the clipboard immediately; status line flashes
  "Copied to clipboard ✓" for 2 seconds.

Implementation notes:

- Python `secrets` → Web Crypto (`crypto.getRandomValues` / `crypto.randomUUID`).
- Base64 output matches Python's `token_urlsafe` (URL-safe alphabet, no padding).
- Alphanumeric uses rejection sampling, same uniformity guarantee as
  `secrets.choice`.
