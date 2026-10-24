from collections.abc import Generator

from sqlalchemy.engine import make_url
from sqlmodel import Session, create_engine

from .config import ROOT, settings


database_url = settings.database_url
connect_args: dict = {}


if settings.is_sqlite:
    connect_args["check_same_thread"] = False

    # 기본 상대경로를 프로젝트 기준 절대경로로 변경한다.
    if database_url == "sqlite:///./data/didim.db":
        database_path = (
            ROOT / "data" / "didim.db"
        ).resolve()

        database_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        database_url = (
            f"sqlite:///{database_path.as_posix()}"
        )

else:
    database_driver = make_url(database_url).drivername

    # psycopg3 전용 설정이다.
    # 연결 풀러에서 서버 연결이 바뀌어도 prepared statement를
    # 재사용하지 않도록 자동 준비 기능을 끈다.
    if database_driver == "postgresql+psycopg":
        connect_args["prepare_threshold"] = None


engine = create_engine(
    database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
)


def get_session() -> Generator[Session, None, None]:
    """FastAPI 요청마다 DB 세션을 만들고 종료 시 닫는다."""
    with Session(engine) as session:
        yield session


def init_sqlite_schema() -> None:
    """
    SQLite 로컬 실행 시 테이블과 누락 컬럼을 보충한다.

    Postgres 스키마는 Alembic 마이그레이션으로 관리한다.
    """
    from sqlmodel import SQLModel

    from . import models  # noqa: F401

    SQLModel.metadata.create_all(engine)

    added_columns = [
        ("case", "based_law", "VARCHAR DEFAULT '[]'"),
        ("assessment", "citations", "VARCHAR DEFAULT '[]'"),
        ("message", "versions", "VARCHAR DEFAULT '[]'"),
    ]

    with engine.connect() as conn:
        for table, column, ddl in added_columns:
            existing = {
                row[1]
                for row in conn.exec_driver_sql(
                    f'PRAGMA table_info("{table}")'
                ).fetchall()
            }

            if column not in existing:
                conn.exec_driver_sql(
                    f'ALTER TABLE "{table}" '
                    f"ADD COLUMN {column} {ddl}"
                )
                conn.commit()