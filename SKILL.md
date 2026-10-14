---
name: kms-graph
description: 승인된 Google Sheets·Notion·CSV 자료를 읽기 전용 Cloudflare 정적 KMS로 빌드한다.
---

# KMS Graph

원본을 읽기만 하며 `out/`에 정적 사이트를 생성한다. 원본의 추가·수정은 Notion 또는 Google Sheets에서 한다.

## 로컬 설정과 의존성

`config.example.json`을 복사해 무시되는 `config.json`을 만든다. 비밀 값은 대화에 붙여 넣지 말고 로컬 설정 또는 환경에만 둔다. Sheets는 `sheet_id`, `service_account_json` 경로가 필요하며, Notion은 `notion_token`, `notion_db_sites`와 선택 `notion_db_data`가 필요하다.

```powershell
python -m pip install -r requirements.txt
npm ci
npm --prefix frontend ci
npm --prefix frontend run build
```

실제 계정·자격 증명이 없는 경우 외부 수집은 검증됐다고 말하지 않는다.

## 빌드

```powershell
python build.py --csv-dir sample --out out --no-check-urls
```

운영 원본은 `npm run build`로 생성한다. 이 명령이 프런트엔드 빌드, `python build.py --config config.json --no-push`, 게시 산출물 검증을 순서대로 실행한다. 기존 CSV의 프롬프트 열은 공개 payload에 내보내지 않는다. 명시적인 AI 프롬프트 자산은 `--knowledge` 또는 `knowledge_file`로 명시한 schema v2 JSON만 병합한다.

내부 보고·스냅샷·미분류 목록은 게시 폴더 밖의 상태 디렉터리에 생성된다. 게시 `out/`에는 `index.html`, `assets/`, 선택 `.nojekyll`만 둘 수 있다. `message.md` 같은 관리 파일이 있으면 빌드는 삭제 없이 실패한다.

## Cloudflare 정적 배포

`npm run deploy:dry-run`으로 산출물 구성을 확인한다. 실제 원격 배포는 명시적인 사용자 승인이 있을 때에만 `npm run deploy`로 실행한다. 이 스킬은 로그인, 원격 리소스 생성, Git push, Teams 알림을 수행하지 않는다.

원본 변경은 자동 반영되지 않는다. 원본 편집 후 다시 빌드하고 다시 배포한다. 상세 절차는 `docs/cloudflare-deployment.ko.md`를 따른다.

## 검증

```powershell
python test_build.py
python test_knowledge.py
npm --prefix frontend run typecheck
npm --prefix frontend test
```

## 금지

- Sheets·Notion 원본, 승인 상태, mappings를 임의로 변경하지 않는다.
- 공개 `out/` 외부의 파일을 게시 대상으로 추가하지 않는다.
- 토큰, 서비스 계정 키, 내부 상태 보고서를 출력하거나 게시하지 않는다.
