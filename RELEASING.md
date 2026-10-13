# Releasing

1. Update the matching versions in `package.json` and `komari-theme.json`.
2. Use a supported Node 22.12–24.x release with npm 10–11, then run:

   ```bash
   npm ci
   ```

   ```bash
   npm run package
   ```

3. Import `release/komari-btop-minimal.zip` into a staging Komari instance when compatibility-sensitive changes were made.
4. Create `docs/releases/v<version>.md` with the exact `# v<version>` heading plus both `## 中文` and `## English` sections.
5. Commit the release, create the matching `v<version>` tag, and push it.
6. The GitHub release workflow rejects missing or malformed versioned notes, then rebuilds and publishes a fresh validated ZIP from the tag.
