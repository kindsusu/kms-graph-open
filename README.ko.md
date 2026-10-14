<p align="center"><img src="assets/kms-graph-hero-v2.svg" alt="KMS Graph — 업무 지식을 연결해서 탐색하는 포털" width="100%"></p>

# KMS Graph

[English](README.md) · 한국어

KMS Graph는 문서, 업무 도구, AI 자산을 검색하고 관계 그래프로 탐색하는 읽기 중심의 사내 지식 포털입니다. 기존 CSV, Google Sheets, Notion 수집 흐름으로 승인된 자료를 정적 사이트에 포함합니다. 업무 분야, 부서, 태그는 검색과 분류에 쓰는 메타데이터이며 그래프 노드가 아닙니다. 프롬프트 본문은 AI 자산 중 `프롬프트` 유형에만 저장하고 표시합니다.

이 공개 예제에는 가상 샘플만 포함하며 실제 조직의 자료나 배포 설정은 포함하지 않습니다. 라이선스는 **PolyForm Noncommercial 1.0.0**으로, 상업적 사용에는 별도 허락이 필요합니다.

## 빠른 실행

Node.js 22.12 이상(권장)과 Python 3.10 이상이 필요합니다. Node.js 20을 사용한다면 20.19 이상이어야 합니다. 저장소 루트에서 실행합니다.

```bash
npm ci
npm --prefix frontend ci
python -m pip install -r requirements.txt
npm run sample:build
python -m http.server --directory out 8765
```

브라우저에서 `http://localhost:8765`를 엽니다. `index.html`을 `file://`로 직접 열면 Worker와 정적 자산이 브라우저 보안 정책에 막힐 수 있습니다.

프런트엔드 개발 서버는 `npm --prefix frontend run dev`로 실행합니다. 이때만 150개 개발 샘플을 자동으로 사용합니다. `http://localhost:5173/?demo=1000`은 그래프 엔진 스트레스 확인용 1,000개 샘플이며 게시 빌드에서는 무시됩니다.

## 화면 사용

- 기본 자료 목록에서 제목, 유형, 업무 분야, 담당, 연결 자료 수와 업데이트를 살펴봅니다. 연결 그래프로 전환하면 작은 점과 연결선을 확대·이동하며 탐색할 수 있습니다.
- 목록 보기는 같은 검색어와 유형·업무 분야 필터를 사용합니다. 행을 열어 상세를 확인해도 그래프로 강제 이동하지 않습니다. 연결 아이콘을 누른 경우에만 그래프에서 해당 자료로 이동합니다.
- `/` 키로 검색창에 이동하고 `Esc`로 검색어를 지웁니다. 상세 자료 ID는 URL 해시에 기록되어 브라우저 뒤로/앞으로 가기와 링크 공유가 가능합니다.
- 업무 도구의 안전한 HTTP(S) 주소가 있을 때만 `원본 열기`가 표시됩니다.
- 검색은 제목을 우선하고 여러 검색어를 부서·분야·관계 설명·공용 프로젝트명에서 함께 찾습니다. 상세에서는 출처, URL 확인 상태, 관계 근거와 지난 게시 대비 재검토 후보를 확인합니다.

## 입력과 빌드

시험용 CSV는 `sample/`에 있으며 `npm run sample:build`가 명시적인 데모 빌드입니다. 운영 빌드는 `config.example.json`을 복사한 무시 대상 `config.json`에서 Google Sheets 또는 Notion 읽기를 설정하고, `repo_dir`을 이 저장소의 정확한 절대 경로로, `out_subdir`을 `out`으로 지정한 뒤 `npm run build`를 실행합니다. 운영 명령은 `config.json`이 없으면 실패하며 샘플 데이터로 대체하지 않습니다. 프런트엔드 빌드, `build.py --config config.json --no-push`, 게시 산출물 검증을 순서대로 수행합니다. `config.json`, 서비스 계정 키와 토큰은 저장소에 커밋하지 마세요.

Cloudflare 설정과 검증, dry-run, 배포 절차는 [docs/cloudflare-deployment.ko.md](docs/cloudflare-deployment.ko.md)에 정리되어 있습니다. 공개 저장소의 CI는 샘플만 검증하며, 선택적 Notion 배포는 개인 설정을 등록한 뒤 수동 실행합니다. `npm run deploy:dry-run`은 설정된 출력물을 검증한 뒤 Wrangler dry-run을 실행합니다. `npm run deploy`는 운영 빌드와 검증을 새로 수행한 뒤 게시하므로 로컬 산출물과 계정 대상을 검토한 후 실행합니다.

확장 지식과 명시적 관계는 schemaVersion 2 JSON으로 제공할 수 있습니다.

```bash
python build.py --csv-dir sample --knowledge sample/knowledge.json --out out --no-check-urls
```

선택적 CSV/Sheets 탭 `자료/items`, `관계/relations`, `공용폴더/shared_folders`, `공용프로젝트/shared_projects`, `공용소속/memberships`로 승인된 독립 자료와 공용 폴더 → 프로젝트 → 자료 구조를 등록할 수 있습니다. Notion은 별도 선택 DB와 `notion_db_<영문탭명>` 설정을 사용합니다. 필드와 승인 규칙은 [입력 예제](sample/explicit-inputs/README.md), [데이터 계약](docs/data-contract.md)을 참고하세요. 승인이 없으면 공개하지 않으며 승인된 관계·소속이 미승인 ID를 참조하면 빌드를 중단합니다. 공용 구조는 원본에서 수정하고 개인 정리는 브라우저에만 저장합니다. CSV 빌드와 Sheets/Notion 모의 응답은 검증했으며 실제 계정 연결은 미검증입니다.

사이트 데이터는 HTML에 포함되므로 생성된 정적 파일을 읽을 수 있는 사람은 포함된 전체 자료를 읽을 수 있습니다. 이 앱은 문서별 접근 권한을 제공하지 않습니다. 외부 게시 전에 호스팅과 인증 계층의 접근 정책을 별도로 검토해야 합니다.

## 검증

```bash
npm --prefix frontend run typecheck
npm --prefix frontend test
npm test
npm run frontend:build
python test_build.py
python test_knowledge.py
```

현재 범위는 수집 가능한 자료를 읽고 검색·목록·그래프로 탐색하는 포털입니다. 선택적 Cloudflare Worker는 Access JWT와 운영자가 설정한 이메일 도메인을 검증합니다. 서버 저장, 공동 편집, 파일 업로드, UI에서의 자료 등록·문서별 권한, AI 실행은 별도 구현이 필요하며 실제 계정 연결과 배포는 사용자가 설정해야 합니다.

Cloudflare에 게시된 포털은 읽기 전용입니다. 자료 추가·수정·삭제는 연결된 Notion 또는 Google Sheets 원본에서 수행하고, 다음 정적 사이트 빌드 때 반영합니다.

개인별 폴더·프로젝트·자료 소속 정리는 브라우저에만 저장되며 원본이나 다른 사용자 화면을 바꾸지 않습니다. 사용법과 백업·복구 범위는 [docs/library-organization.ko.md](docs/library-organization.ko.md)를 참고하세요.

## 주요 파일

| 경로 | 역할 |
|---|---|
| `frontend/` | React + TypeScript 화면과 그래프 Worker |
| `build.py` | 입력 수집·검증과 정적 사이트 생성 |
| `knowledge.py` | schemaVersion 2 지식 데이터 처리 |
| `sample/` | 로컬 시험 입력 |
| `out/` | 생성된 게시 파일(버전 관리 제외) |

## 라이선스

PolyForm Noncommercial 1.0.0. 소스 공개와 비상업적 이용을 허용하는 라이선스이며 OSI 승인 오픈소스 라이선스는 아닙니다. 정확한 범위와 제한은 [LICENSE](LICENSE)를 확인하세요.
