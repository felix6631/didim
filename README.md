# 디딤 (DIDIM)

교직원이 교육활동 침해가 의심되는 상황을 대화로 정리하고, 위험도와 대응 방안을 확인하며, 상담 내용을 사건 보고서로 인쇄할 수 있는 웹 애플리케이션입니다. **결과는 참고 자료이며 법률적·행정적 최종 판단이 아닙니다.** 실제 신고·징계·법적 조치 전에는 학교 관리자와 관련 전문가의 검토가 필요합니다.

## 주요 기능

- **교직원 계정:** 계정 발급 신청 시 교직원 확인 문서를 제출하고, 관리자가 확인 후 승인하거나 사유를 적어 거절합니다. 문서의 진위는 자동 검증하지 않습니다.
- **사용자별 상담:** 로그인한 사용자의 상담 목록, 메시지, 평가 이력과 첨부 자료를 저장합니다. 다른 사용자의 상담은 조회할 수 없습니다.
- **상담과 위험도:** 답변을 실시간 스트리밍으로 표시하고, 상황 분류·0-100 위험 점수·대응 권고를 제공합니다. 위험 단계는 일반(`low`, 0-29), 주의(`caution`, 30-59), 위험(`danger`, 60-89), 긴급(`emergency`, 90-100)입니다.
- **두 가지 분석 모드:** 기본 데모 모드는 키워드 규칙과 미리 작성된 문구를 사용합니다. `DEMO_MODE=false`와 Anthropic API 키를 함께 설정하면 Claude를 사용합니다.
- **법령 근거:** Claude 모드에서 법령 전용 검색 DB를 조회하고, 관련 조문을 최대 3개까지 선택해 원문·출처·선택 이유를 표시합니다. 법령 DB가 준비되지 않았거나 검색에 실패하면 조문이 표시되지 않을 수 있습니다. 데모 모드에서는 조문 검색을 실행하지 않습니다.
- **첨부·보고서:** 상담별 파일을 업로드·다운로드·삭제하고, 브라우저의 인쇄 기능으로 상담 기록과 평가 결과를 PDF로 저장할 수 있습니다. 보고서에는 첨부파일의 내용 대신 파일 목록이 표시됩니다.
- **화면 편의 기능:** 답변 복사, 브라우저 음성 입력, 메시지 북마크, 다크 모드, 설치형 웹 앱용 manifest 및 정적 화면 캐시가 포함되어 있습니다. API 요청은 오프라인 캐시 대상이 아닙니다.

## 구성

| 부분 | 기술과 역할 |
| --- | --- |
| 화면 | React, TypeScript, Vite |
| API | FastAPI, SQLModel, SSE 스트리밍 |
| 상담 데이터 | SQLite 기본값 또는 `DATABASE_URL`로 설정한 PostgreSQL; PostgreSQL 스키마는 Alembic으로 관리 |
| 상담 첨부 | 서버의 `UPLOAD_DIR` 폴더 |
| 가입 증빙 | Supabase Storage의 비공개 버킷 |
| 법령 근거 | `data/legal/articles.json`을 바탕으로 생성하는 별도 SQLite DB와 FTS 색인 |

## 빠른 실행: Windows

Python 3.11 이상과 Node.js를 설치합니다. 레포 루트에서 `.env.example`을 `.env`로 복사한 뒤 **`DATABASE_URL`을 실제 연결 가능한 DB로 수정**하세요. 예제 파일의 DB 주소는 그대로 사용할 수 있는 값이 아닙니다. 로컬에서 시험한다면 아래 설정으로 시작할 수 있습니다.

```env
APP_ENV=development
DATABASE_URL=sqlite:///./data/didim.db
DEMO_MODE=true
ANTHROPIC_API_KEY=
UPLOAD_DIR=./data/uploads
COOKIE_SECURE=false
LEGAL_CITATIONS_ENABLED=true
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_STORAGE_BUCKET=registration-documents
```

이어서 레포 루트에서 `start.bat`을 실행합니다. PowerShell에서는 `./start.ps1`을 사용할 수 있습니다. 실행 스크립트가 Python 패키지와 프런트엔드 패키지를 설치하고, 제공된 법령 JSON으로 검색 DB를 준비한 뒤 API와 화면을 실행합니다.

- 화면: <http://localhost:5173>
- API 문서: <http://localhost:8000/docs>
- 상태 확인: <http://localhost:8000/api/health>

처음 실행한 뒤 **새 터미널에서** 관리자 계정을 생성합니다. SQLite 기본 설정에서는 서버가 첫 실행 시 필요한 테이블을 생성합니다.

```powershell
cd backend
..\.venv\Scripts\python.exe -m scripts.create_admin
```

명령어가 관리자 아이디·이름·비밀번호를 입력받습니다. 비밀번호는 12자 이상이어야 합니다. 실행 후 관리자 계정으로 로그인할 수 있습니다. 교사 계정을 직접 만들려면 같은 위치에서 `-m scripts.create_teacher`를 실행하세요.

**가입 신청을 사용하려면** `.env`에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`을 실제 비공개 Storage 버킷 값으로 설정해야 합니다. 이를 설정하지 않으면 증빙 문서 업로드가 실패하므로 가입 신청을 완료할 수 없습니다. 로컬 데모에서는 관리자·교사 계정을 CLI로 생성해 상담 기능을 확인할 수 있습니다. 비밀 키와 실사용 비밀번호는 레포에 올리지 마세요.

## 수동 실행: macOS / Linux / Codespaces

레포 루트에서 다음을 실행합니다.

```bash
cp .env.example .env
# .env의 DATABASE_URL 등을 위 설명에 맞게 수정
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend && npm install && cd ..
```

터미널을 두 개 열어 각각 실행합니다.

```bash
# 터미널 1: 레포 루트
.venv/bin/python -m uvicorn app.main:app --app-dir backend --reload --port 8000
```

```bash
# 터미널 2: 레포 루트
cd frontend
npm run dev
```

서버를 처음 실행한 뒤 계정이 필요하면 다음을 실행합니다.

```bash
cd backend
../.venv/bin/python -m scripts.create_admin
# 필요하면 ../.venv/bin/python -m scripts.create_teacher
```

macOS/Linux에서는 설정을 마친 후 레포 루트의 `./start.sh`로 의존성 설치와 두 서버 실행을 한 번에 할 수도 있습니다.

### PostgreSQL을 사용하는 경우

`DATABASE_URL`을 유효한 `postgresql+psycopg://...` 주소로 설정하고, **계정 생성 및 API 사용 전에** 레포의 마이그레이션을 적용합니다.

```bash
cd backend
../.venv/bin/python -m alembic upgrade head
```

Windows에서는 위 명령의 Python 경로를 `..\.venv\Scripts\python.exe`로 바꾸세요. 운영 DB 연결 정보는 `.env`에만 보관하세요.

## Claude 및 법령 검색

데모 모드는 외부 AI 호출 없이 동작합니다. Claude를 사용하려면 `.env`에 다음 값을 넣고 서버를 재시작합니다.

```env
DEMO_MODE=false
ANTHROPIC_API_KEY=여기에_발급받은_키
ANTHROPIC_MODEL=사용할_모델_ID
LEGAL_CITATIONS_ENABLED=true
```

법령 데이터 원본 `data/legal/articles.json`은 레포에 있습니다. 검색 DB인 `data/legal/legal.db`를 직접 준비하려면 백엔드에서 다음을 실행하세요. 시작 스크립트도 이 작업을 실행합니다.

```bash
cd backend
../.venv/bin/python -m app.legal.ingest --from-json
```

국가법령정보센터에서 법령을 **다시 수집**하려면 `LAW_API_OC`를 `.env`에 설정한 뒤 `--from-json` 없이 실행합니다. 수집 스크립트는 서버 요청 중에 자동 실행되지 않습니다. 제공된 법령 파일의 기준 시점과 법령 개정 여부는 별도로 확인해야 합니다.

```bash
cd backend
../.venv/bin/python -m app.legal.ingest
```

## 데이터와 개인정보

- 상담 메시지 원문과 AI 답변, 위험도 평가 이력은 메인 DB에 저장됩니다. `json/program_config.json`의 `store_conversation: false` 문구는 현재 API 저장 동작과 일치하지 않습니다.
- 전화번호·주민등록번호·이메일의 일부 형식은 Claude에 전달하기 전에 마스킹합니다. **저장되는 상담 원문은 마스킹되지 않으며**, 사람 이름·주소까지 자동으로 가리지는 않습니다. 실제 인물 정보는 입력 전에 가명으로 바꾸세요.
- 로그인 비밀번호는 해시로, 세션 토큰은 원문 대신 해시로 DB에 저장합니다. 가입 증빙은 메인 DB가 아닌 별도 비공개 Storage에 두며 DB에는 파일 경로·해시 등 메타데이터를 저장합니다.
- 가입 증빙에는 30일 후 삭제 예정 시각이 기록되지만, 이 레포에는 예정 시각에 파일을 자동 삭제하는 작업이 보이지 않습니다. 보관 정책을 적용하려면 별도 삭제 작업이 필요합니다.
- `.env.example`에 들어 있는 예시 계정 정보는 자동으로 계정을 생성하지 않습니다. 실제 운영에 그 아이디와 비밀번호를 재사용하지 마세요.

## 테스트와 빌드

```bash
cd backend
../.venv/bin/python -m pytest
```

```bash
cd frontend
npm run build
```

Windows에서는 Python 경로를 `..\.venv\Scripts\python.exe`로 바꾸세요. 백엔드 테스트에는 개인정보 마스킹, 가입 증빙 권한, 법령 파싱·검색·선택 검사가 포함되어 있습니다.

## 현재 구현의 범위

- 위험도는 상담 지원용 점수입니다. 실제 교육활동 침해 여부나 법률 적용을 확정하지 않습니다.
- 데모 모드는 몇 가지 단어의 포함 여부로 분류하며, 문맥을 이해하는 모델이 아닙니다.
- 상담 API는 한 글자 입력을 허용하지만, 현재 화면의 보내기 버튼은 공백 제거 후 두 글자 미만일 때 비활성화됩니다.
- 웹 앱의 정적 화면은 캐시될 수 있지만 상담 API·AI 답변은 서버 연결이 필요합니다.

## 주요 경로

| 경로 | 내용 |
| --- | --- |
| `frontend/src/App.tsx` | 상담 화면과 인쇄용 보고서 |
| `frontend/src/RegistrationPage.tsx` | 교직원 계정 신청 |
| `frontend/src/AdminRegistrationPage.tsx` | 관리자 신청 심사 |
| `backend/app/main.py` | 상담·메시지·첨부·위험도 API |
| `backend/app/routers/` | 로그인 및 계정 발급 API |
| `backend/app/legal/` | 법령 수집·검색·조문 선택 |
| `backend/app/models.py` | 데이터 모델 |
| `backend/migrations/` | 메인 DB 마이그레이션 |
