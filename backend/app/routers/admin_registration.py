from datetime import datetime, timezone
from typing import Annotated
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    status,
)
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..database import get_session
from ..models import (
    RegistrationApplication,
    RegistrationDocument,
    User,
)
from ..services.storage_service import (
    StorageOperationError,
    download_registration_document,
)
from .auth import CurrentUserDependency


router = APIRouter(
    prefix="/api/admin/registration-applications",
    tags=["admin-registration"],
)

SessionDependency = Annotated[
    Session,
    Depends(get_session),
]


class RejectApplicationRequest(BaseModel):
    reason: str = Field(
        min_length=2,
        max_length=500,
    )


def now_iso() -> str:
    return datetime.now(
        timezone.utc,
    ).isoformat()


def require_admin(
    current_user: User,
) -> None:
    if current_user.role not in {
        "admin",
        "super_admin",
    }:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="관리자만 사용할 수 있습니다.",
        )


def serialize_application(
    application: RegistrationApplication,
    document: RegistrationDocument | None,
) -> dict:
    document_data = None

    if document is not None:
        document_data = {
            "id": document.id,
            "original_filename": (
                document.original_filename
            ),
            "content_type": document.content_type,
            "size": document.size,
            "sha256": document.sha256,
            "created_at": document.created_at,
            "deleted_at": document.deleted_at,
        }

    return {
        "id": application.id,
        "username": application.username,
        "name": application.name,
        "school_name": application.school_name,
        "email": application.email,
        "phone": application.phone,
        "status": application.status,
        "rejection_reason": (
            application.rejection_reason
        ),
        "reviewed_by": application.reviewed_by,
        "reviewed_at": application.reviewed_at,
        "document_delete_after": (
            application.document_delete_after
        ),
        "created_at": application.created_at,
        "updated_at": application.updated_at,
        "document": document_data,
    }


@router.get("")
def list_registration_applications(
    current_user: CurrentUserDependency,
    session: SessionDependency,
    application_status: str | None = None,
) -> list[dict]:
    require_admin(current_user)

    statement = select(
        RegistrationApplication,
    ).order_by(
        RegistrationApplication.created_at.desc(),
    )

    if application_status is not None:
        if application_status not in {
            "pending",
            "approved",
            "rejected",
        }:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="올바르지 않은 신청 상태입니다.",
            )

        statement = statement.where(
            RegistrationApplication.status
            == application_status
        )

    applications = session.exec(
        statement,
    ).all()

    result: list[dict] = []

    for application in applications:
        document = session.exec(
            select(RegistrationDocument).where(
                RegistrationDocument.application_id
                == application.id
            )
        ).first()

        result.append(
            serialize_application(
                application,
                document,
            )
        )

    return result


@router.get("/{application_id}/document")
def view_registration_document(
    application_id: int,
    current_user: CurrentUserDependency,
    session: SessionDependency,
) -> Response:
    """관리자에게만 비공개 가입 증빙 파일을 브라우저에서 보여준다."""
    require_admin(current_user)

    application = session.get(
        RegistrationApplication,
        application_id,
    )
    if application is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="회원가입 신청을 찾을 수 없습니다.",
        )

    document = session.exec(
        select(RegistrationDocument).where(
            RegistrationDocument.application_id == application.id,
            RegistrationDocument.deleted_at.is_(None),
        )
    ).first()
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="제출 문서를 찾을 수 없습니다.",
        )

    # 기존 가입 신청 API가 허용한 형식만 브라우저에 inline으로 전달한다.
    allowed_types = {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
    }
    content_type = document.content_type.lower()
    if content_type not in allowed_types:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="미리보기를 지원하지 않는 문서 형식입니다.",
        )

    try:
        content = download_registration_document(document.storage_path)
    except StorageOperationError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="제출 문서를 불러오지 못했습니다.",
        ) from error

    filename = quote(document.original_filename, safe="")
    fallback = f"document.{allowed_types[content_type]}"
    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Content-Disposition": (
                f"inline; filename=\"{fallback}\"; "
                f"filename*=UTF-8''{filename}"
            ),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{application_id}/approve")
def approve_registration_application(
    application_id: int,
    current_user: CurrentUserDependency,
    session: SessionDependency,
) -> dict:
    require_admin(current_user)

    application = session.get(
        RegistrationApplication,
        application_id,
    )

    if application is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="회원가입 신청을 찾을 수 없습니다.",
        )

    if application.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 처리된 신청입니다.",
        )

    existing_user = session.exec(
        select(User).where(
            User.username == application.username,
        )
    ).first()

    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 같은 아이디의 계정이 있습니다.",
        )

    reviewed_at = now_iso()

    user = User(
        username=application.username,
        password_hash=application.password_hash,
        name=application.name,
        role="teacher",
        is_active=True,
        created_at=reviewed_at,
    )

    application.status = "approved"
    application.rejection_reason = None
    application.reviewed_by = current_user.id
    application.reviewed_at = reviewed_at
    application.updated_at = reviewed_at

    try:
        session.add(user)
        session.add(application)
        session.commit()
        session.refresh(user)

    except Exception as error:
        session.rollback()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="신청을 승인하지 못했습니다.",
        ) from error

    return {
        "message": "신청을 승인하고 교사 계정을 생성했습니다.",
        "application_id": application.id,
        "status": application.status,
        "user": {
            "id": user.id,
            "username": user.username,
            "name": user.name,
            "role": user.role,
            "is_active": user.is_active,
        },
    }


@router.post("/{application_id}/reject")
def reject_registration_application(
    application_id: int,
    body: RejectApplicationRequest,
    current_user: CurrentUserDependency,
    session: SessionDependency,
) -> dict:
    require_admin(current_user)

    application = session.get(
        RegistrationApplication,
        application_id,
    )

    if application is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="회원가입 신청을 찾을 수 없습니다.",
        )

    if application.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 처리된 신청입니다.",
        )

    rejection_reason = body.reason.strip()

    if len(rejection_reason) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="거절 사유를 입력하세요.",
        )

    reviewed_at = now_iso()

    application.status = "rejected"
    application.rejection_reason = rejection_reason
    application.reviewed_by = current_user.id
    application.reviewed_at = reviewed_at
    application.updated_at = reviewed_at

    try:
        session.add(application)
        session.commit()

    except Exception as error:
        session.rollback()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="신청을 거절하지 못했습니다.",
        ) from error

    return {
        "message": "회원가입 신청을 거절했습니다.",
        "application_id": application.id,
        "status": application.status,
        "rejection_reason": (
            application.rejection_reason
        ),
    }
