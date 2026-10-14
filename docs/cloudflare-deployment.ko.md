# Cloudflare 배포 예제

이 저장소는 배포된 서비스의 설정값이나 콘텐츠를 포함하지 않는다. `wrangler.jsonc`에는 도메인 경로와 Access 인증값을 넣지 않았다. 샘플 빌드는 로컬 시험용이다.

## 준비

1. 본인이 소유한 Cloudflare 계정에서 Worker와 사용자 도메인을 준비한다.
2. 해당 호스트 전체를 보호하는 Cloudflare Access self-hosted 앱과 허용 정책을 만든다.
3. `wrangler.jsonc`의 `routes`에 본인의 호스트를 설정한다. `workers_dev`와 `preview_urls`는 비활성화 상태를 유지한다.
4. Worker 배포 변수로 `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAIL_DOMAIN`을 설정한다. 이메일 도메인은 `example.com` 같은 소유 도메인으로 바꾼다. 세 값 중 하나라도 없으면 Worker는 모든 자산 요청을 거부한다.
5. 실제 자료를 읽는 경우 [Notion 수동 동기화 안내](notion-auto-sync.ko.md)에 따라 저장소별 비밀값과 원본 설정을 별도로 등록한다.

GitHub Actions의 `Sample build and tests`는 예제 데이터만 빌드한다. 배포는 자동 예약하지 않는다. `Manual Notion sync and deploy`는 저장소 관리자가 비밀값과 변수를 모두 등록하고 직접 실행할 때에만 작동한다. 처음 배포 전에는 Access 앱의 호스트와 AUD가 올바른지 확인하고, 결과 페이지와 자산 파일이 미인증 요청에서 차단되는지 검증한다.

인증된 사용자는 정적 HTML에 포함된 모든 자료를 읽을 수 있다. 문서별 권한이 필요하면 별도 설계가 필요하다. 비용과 한도는 사용하는 계정의 플랜 및 현재 서비스 약관에서 확인한다.
