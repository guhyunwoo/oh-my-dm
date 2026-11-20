# 릴리스 / Releasing

[한국어](#한국어) · [English](#english)

## 한국어

릴리스는 자동화되어 있습니다. Maintainer는 version, tag 또는 생성된 changelog 항목을 직접 편집하지 않습니다.

### 릴리스 흐름

1. Conventional Commit 형식의 PR을 `main`에 병합합니다.
2. Release Please가 다음 version과 changelog를 담은 release PR을 생성하거나 갱신합니다.
3. Release PR의 CI와 내용을 확인한 뒤 병합합니다.
4. Release Please가 `vX.Y.Z` tag와 GitHub Release를 생성합니다.
5. `publish.yml`이 tag와 `package.json` version의 일치를 검증하고 build한 뒤 provenance를 포함해 npm에 배포합니다.

Version 규칙:

- `feat`: minor (`0.6.0` → `0.7.0`)
- `fix` 또는 `perf`: patch (`0.6.0` → `0.6.1`)
- `docs`, `test`, `ci`, `chore`: 단독으로는 release를 만들지 않음
- `!` 또는 `BREAKING CHANGE:`: 1.0 이전에는 minor, 1.0 이후에는 major

### 자동 릴리스 실행

사용자가 현재 변경분의 QA 통과를 명시하고 배포를 요청한 경우에만 저장소용 release automation을 실행합니다. 자동화는 정확히 staging된 diff를 다시 검증하고 commit, push, main CI 확인, release PR 검사와 병합, GitHub Release 생성, npm Trusted Publishing 확인을 순서대로 수행합니다. 실패한 단계가 있으면 우회하지 않고 그 자리에서 중단합니다.

### npm Trusted Publishing

npm package 설정에는 다음 GitHub Actions trusted publisher가 등록되어 있어야 합니다.

- Organization 또는 user: `guhyunwoo`
- Repository: `oh-my-dm`
- Workflow: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

`package.json`의 `repository.url`도 같은 저장소(`github.com/guhyunwoo/oh-my-dm`)를 가리켜야 합니다. npm provenance 검증이 OIDC claim의 저장소와 이 값을 비교합니다.

GitHub의 `npm` environment는 production publishing을 보호합니다. Workflow는 prerelease가 아닌 GitHub Release에서만 실행되고 tag가 `package.json`과 정확히 일치하는지 확인합니다. 이미 npm에 존재하는 version은 안전하게 건너뜁니다. 모든 자동 배포는 단기 OIDC credential과 npm provenance를 사용하며 npm automation token을 GitHub에 저장하지 않습니다.

### GitHub Release 설정

Release Please가 release PR을 만들려면 다음 중 하나가 필요합니다.

1. **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**를 organization 또는 repository에서 허용하거나,
2. 이 저장소만 대상으로 **Contents: write**, **Pull requests: write** 권한을 가진 fine-grained PAT 또는 GitHub App token을 `RELEASE_PLEASE_TOKEN` repository secret으로 추가합니다.
   Fine-grained PAT의 resource owner는 저장소 소유자(`guhyunwoo`)여야 합니다. 저장소를 다른 계정이나 organization으로 옮기면 기존 token은 쓰기 권한을 잃으므로 새 owner로 다시 발급하세요. Release에 workflow 파일 변경이 포함될 수 있으므로 **Workflows: write**도 허용합니다.

Token은 관련 없는 organization 권한을 포함하면 안 되며 repository에 commit하지 않습니다. Release PR을 병합하는 로컬 `gh` CLI 계정도 저장소 write 권한과 유효한 인증을 가지고 있어야 합니다.

### 장애 복구

- 검증 실패: source를 수정한 새 PR을 만들고 기존 tag를 이동하지 마세요.
- GitHub Release는 생성됐지만 npm publish가 실패: environment 또는 trusted publisher를 수정하고 실패한 workflow를 다시 실행하세요.
- 같은 version이 npm에 이미 존재: 덮어쓰지 말고 새 fix commit과 release를 만드세요.
- Release가 손상됨: npm version을 deprecate하고 수정 version을 배포한 뒤 [SECURITY.md](../SECURITY.md)를 따르세요.

## English

Releases are automated. Maintainers must not edit versions, tags, or generated changelog entries manually.

### Release flow

1. Merge pull requests with Conventional Commit titles into `main`.
2. Release Please creates or updates a release PR containing the next version and changelog.
3. Review its CI and contents, then merge the release PR.
4. Release Please creates a `vX.Y.Z` tag and GitHub Release.
5. `publish.yml` verifies that the tag matches `package.json`, builds the package, and publishes it to npm with provenance.

Version rules:

- `feat`: minor (`0.6.0` → `0.7.0`)
- `fix` or `perf`: patch (`0.6.0` → `0.6.1`)
- `docs`, `test`, `ci`, and `chore`: no release by themselves
- `!` or `BREAKING CHANGE:`: minor before 1.0, major after 1.0

### Running the automated release

Run the repository release automation only after the user explicitly confirms that the current changes passed QA and asks to deploy them. The automation re-verifies the exact staged diff, commits, pushes, checks main CI, checks and merges the release PR, creates the GitHub Release, and verifies npm Trusted Publishing in that order. If any stage fails, stop there without bypassing it.

### npm Trusted Publishing

The npm package settings must contain this GitHub Actions trusted publisher:

- Organization or user: `guhyunwoo`
- Repository: `oh-my-dm`
- Workflow: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

`repository.url` in `package.json` must point to the same repository (`github.com/guhyunwoo/oh-my-dm`). npm provenance verification compares it with the repository in the OIDC claim.

The GitHub environment named `npm` protects production publishing. The workflow runs only for a non-prerelease GitHub Release and verifies that its tag exactly matches `package.json`. It safely skips a version that already exists on npm. Every automated release uses short-lived OIDC credentials and npm provenance; no npm automation token is stored in GitHub.

### GitHub Release setup

Release Please needs permission to create a release pull request. Choose one option:

1. Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** at the organization or repository level; or
2. Add a repository secret named `RELEASE_PLEASE_TOKEN` containing a fine-grained PAT or GitHub App token scoped only to this repository with **Contents: write** and **Pull requests: write**.
   The fine-grained PAT's resource owner must be the repository owner (`guhyunwoo`). Transferring the repository to another account or organization removes the old token's write access, so issue a new one for the new owner. Also allow **Workflows: write**, because a release can include workflow file changes.

The token must not include unrelated organization access and must never be committed. The local `gh` CLI account used to merge the release PR also needs repository write access and valid authentication.

### Recovery

- Failed verification: fix the source through a new pull request; never move an existing tag.
- GitHub Release exists but npm publish failed: fix the environment or trusted publisher and rerun the failed workflow.
- Version already exists on npm: do not overwrite it. Create a new fix commit and release.
- Compromised release: deprecate the npm version, publish a fixed version, and follow [SECURITY.md](../SECURITY.md).
