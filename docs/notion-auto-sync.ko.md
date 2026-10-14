# Notion 수동 동기화

예제 저장소는 실제 Notion 자료함 식별자, 토큰 또는 게시 콘텐츠를 포함하지 않는다. [원본 설정 예시](../config/notion-sources.example.json)의 ID는 가상값이다. 노션 통합에 콘텐츠 읽기 권한을 부여하고 사용할 자료함을 연결한 뒤, 본인 설정을 비공개로 보관한다.

## GitHub 설정

Actions Secrets:

- `NOTION_TOKEN`: 읽기 권한이 있는 Notion 통합 토큰
- `NOTION_SOURCES_JSON`: 예시와 같은 형식의 실제 자료함 설정 JSON
- `CF_API_TOKEN`: Worker 버전 업로드·배포 및 Access 앱 조회 권한이 있는 Cloudflare 토큰
- `CF_ACCOUNT_ID`: 대상 계정 ID

Actions Variables:

- `KMS_HOSTNAME`: 본인이 소유한 게시 호스트(예: `kms.example.com`)
- `ACCESS_APP_ID`: 호스트 전체를 보호하는 Cloudflare Access 앱 UUID
- `ACCESS_AUD`: Access 앱 AUD
- `ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`
- `ALLOWED_EMAIL_DOMAIN`: 접근을 허용할 이메일 도메인

`wrangler.jsonc`의 `routes`에도 실제 호스트를 지정해야 한다. 위 값이 비어 있거나 예시값 그대로면 수동 워크플로는 배포하지 않는다. 저장소 기본 설정에는 예약 실행이 없다. 필요한 경우 저장소 관리자가 `Manual Notion sync and deploy`를 직접 실행한다. 일정 실행을 추가할 때에는 비용·호출 한도와 원본 접근 범위를 먼저 검토한다.

## 동작

수집기는 각 원본의 페이지와 중첩 블록을 읽고, 누락이나 오류가 있으면 게시를 중단한다. 동일 Notion 페이지에는 안정적인 자료 ID를 부여한다. 인증 문자열과 만료되는 서명 URL은 본문에서 제거한다. 연결 가능한 Notion 페이지 참조만 관계로 만든다. 포함된 자료 전체를 인증된 사이트 방문자가 읽을 수 있으므로 원본 공유 범위와 게시 대상은 운영자가 검토해야 한다.

로컬 시험은 환경 변수 `NOTION_TOKEN`을 설정하고 `npm --prefix frontend run build` 후 `python scripts/sync_notion.py --sources <개인 설정 JSON> --out out`으로 실행한다. `out/`과 `.qa/`는 Git에서 무시한다. 실제 자료를 공개 저장소나 CI 아티팩트로 올리지 않는다.

API 참고: [Notion 데이터 소스 조회](https://developers.notion.com/reference/query-a-data-source), [블록 자식 조회](https://developers.notion.com/reference/get-block-children).
