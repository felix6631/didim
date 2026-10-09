"""가입 증빙 파일은 관리자만 해당 신청의 파일을 열 수 있다."""

import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy.pool import StaticPool

from app.models import RegistrationApplication, RegistrationDocument, User
from app.routers import admin_registration


@pytest.fixture
def application_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        application = RegistrationApplication(
            username="sample_teacher",
            password_hash="test-hash",
            name="교사",
            school_name="예시 학교",
            email="teacher@example.test",
        )
        session.add(application)
        session.commit()
        session.refresh(application)

        document = RegistrationDocument(
            application_id=application.id,
            original_filename="재직증명서.pdf",
            storage_path="applications/example.pdf",
            content_type="application/pdf",
            size=13,
            sha256="sample-hash",
        )
        session.add(document)
        session.commit()
        yield session, application.id


def test_admin_can_open_private_document(application_session, monkeypatch):
    session, application_id = application_session
    fetched_paths = []

    def fake_download(path):
        fetched_paths.append(path)
        return b"%PDF-1.4 test"

    monkeypatch.setattr(
        admin_registration,
        "download_registration_document",
        fake_download,
    )
    admin = User(username="admin", password_hash="hash", name="관리자", role="admin")

    response = admin_registration.view_registration_document(
        application_id=application_id,
        current_user=admin,
        session=session,
    )

    assert response.body == b"%PDF-1.4 test"
    assert response.media_type == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["cache-control"] == "private, no-store"
    assert fetched_paths == ["applications/example.pdf"]


def test_teacher_cannot_download_document(application_session, monkeypatch):
    session, application_id = application_session

    def unexpected_download(_path):
        pytest.fail("권한이 없는 사용자에게 Storage 파일을 요청했습니다.")

    monkeypatch.setattr(
        admin_registration,
        "download_registration_document",
        unexpected_download,
    )
    teacher = User(username="teacher", password_hash="hash", name="교사", role="teacher")

    with pytest.raises(HTTPException) as error:
        admin_registration.view_registration_document(
            application_id=application_id,
            current_user=teacher,
            session=session,
        )

    assert error.value.status_code == 403
