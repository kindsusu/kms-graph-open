# 명시 자료 입력 예제

이 폴더의 CSV 5개를 기존 `사이트.csv`, `도메인.csv`, `참조데이터.csv`가 있는 입력 폴더에 복사한 뒤 빌드합니다. 기본 sample 빌드는 이 하위 폴더를 자동 병합하지 않습니다. 독립 문서는 기존 사이트의 참조 없이 게시할 수 있습니다.

Google Sheets에는 동일 헤더의 `자료/items`, `관계/relations`, `공용폴더/shared_folders`, `공용프로젝트/shared_projects`, `공용소속/memberships` 탭을 선택적으로 추가합니다. 한국어 또는 영문 탭 이름 중 하나를 사용합니다.

Notion에는 동일 속성의 별도 DB를 만들고 로컬 설정에 `notion_db_items`, `notion_db_relations`, `notion_db_shared_folders`, `notion_db_shared_projects`, `notion_db_memberships` DB ID를 추가합니다. 관계·소속의 ID 속성은 rich_text를 사용합니다. Notion의 relation 속성은 해석하지 않습니다. 승인 속성은 checkbox를 사용합니다. 자료 ID가 없으면 Notion 페이지 ID로 생성한 `source-<hash>`를 사용하므로, 다른 행에서 참조할 자료는 명시 ID를 권장합니다.

관계와 소속은 `approved=TRUE`이고 양 끝 자료·소속이 게시될 때만 유효합니다. 승인 관계가 미승인 자료를 가리키면 빌드를 중단합니다. 기존 미승인 자료를 관계로 공개하지 않습니다. 예제 URL은 실제 계정 연결 또는 접속 확인을 의미하지 않습니다.
