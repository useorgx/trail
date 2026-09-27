# Releasing

## One-time npm setup

Do this in the npm website. Do not add an npm token to GitHub.

1. Open the [`@useorgx/trail` package](https://www.npmjs.com/package/@useorgx/trail) while signed in as a maintainer.
2. Open **Settings**, then **Trusted publisher**.
3. Choose **GitHub Actions**.
4. Set the organization or user to `useorgx`.
5. Set the repository to `trail`.
6. Set the workflow filename to `publish.yml`.
7. Leave the environment blank and save the trusted publisher.

## Release a version

Start from a clean, current `main` branch. Replace `X.Y.Z` below with the release version.

1. Bump `package.json` without creating a tag yet:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

2. Run the release checks:

   ```bash
   npm test
   npm pack --dry-run
   ```

3. Commit the version bump through the normal review process.
4. Tag that commit. The tag must exactly match the version in `package.json`:

   ```bash
   git tag vX.Y.Z
   ```

5. Push the commit, then push the tag:

   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

The tag starts `.github/workflows/publish.yml`. The workflow rejects a tag that does not match `package.json`, runs `npm test`, and publishes with npm provenance through trusted publishing.
