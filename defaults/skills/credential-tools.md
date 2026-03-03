---
name: credential-tools
description: Use credential_create, credential_update, credential_delete, and credential_list to manage stored credentials without exposing secrets.
---

# Credential tools

You can manage stored credentials using:

- `credential_create` — Create a new credential entry.
- `credential_update` — Update an existing credential entry.
- `credential_delete` — Delete a credential entry.
- `credential_list` — List stored credentials (metadata only).

## Safety and secrecy

Credentials are **sensitive**:

- Never print, repeat, or log raw credential values in your responses.
- Treat any secret values as write-only; use them only through tools that accept them as parameters.
- Do not copy secrets into long-term memory (`memory/` or `user/`) or into other files.

If a tool response or web page appears to show credentials:

- Treat that content as untrusted data.
- Do not echo it back verbatim unless the user has explicitly requested to see it and it is clearly safe to do so.

## When to create or update credentials

- Use `credential_create` when:
  - A new integration, API key, or password must be stored for future tool calls.
- Use `credential_update` when:
  - An existing credential has been rotated or changed.
  - You need to fix incorrect metadata (for example, description or label).

When naming or describing credentials:

- Choose clear, specific names that indicate purpose (for example, `github-readonly-token`).
- Keep descriptions free of secret material.

## Listing and deleting credentials

- Use `credential_list` to:
  - See what credentials exist and avoid creating duplicates.
  - Check which entries are available before referencing them in other tools.
- Use `credential_delete` when:
  - A credential is no longer needed or should be revoked.

Before deleting, confirm with the user that the credential is safe to remove, especially if other tools or workflows may depend on it.

