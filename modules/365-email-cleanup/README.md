# 365 Email Cleanup (launcher module)

The original "Inbox Cleanup" v1.3.0 is a C#/.NET 8 WPF app that automates **classic
Outlook desktop via COM** (late-bound `Outlook.Application`), stores secrets with
Windows DPAPI, ships Ed25519-signed licensing/activation, and opens several of its
own WPF windows (Draft, History, Manage, Settings, Activation, EULA).

That surface (COM automation + licensing gate) can't be meaningfully embedded in a
React route, so this module **launches the existing exe**:

- Default path: the published build under
  `_Active Projects\365 Email Cleanup\build\publish\`; falls back to a
  `Program Files` install if present; overridable via Browse (persisted).
- No elevation involved.
- Requires classic Outlook (not "new Outlook") for MAPI/COM.
- Its Gemini/DeepSeek AI-drafting keys are managed inside the app itself
  (DPAPI-encrypted), not by WICKED settings.
