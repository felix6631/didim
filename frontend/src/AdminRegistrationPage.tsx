import {
  useEffect,
  useState,
} from "react";

import {
  approveRegistrationApplication,
  listRegistrationApplications,
  RegistrationApiError,
  rejectRegistrationApplication,
  type RegistrationApplication,
} from "./registrationApi";


interface AdminRegistrationPageProps {
  onBack: () => void;
}


function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("ko-KR");
}


function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}


export default function AdminRegistrationPage({
  onBack,
}: AdminRegistrationPageProps) {
  const [applications, setApplications] = useState<
    RegistrationApplication[]
  >([]);

  const [rejectReasons, setRejectReasons] = useState<
    Record<number, string>
  >({});

  const [loading, setLoading] = useState(true);

  const [processingId, setProcessingId] = useState<
    number | null
  >(null);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");


  async function loadApplications(): Promise<void> {
    setLoading(true);
    setError("");

    try {
      const result = await listRegistrationApplications(
        "pending",
      );

      setApplications(result);
    } catch (caughtError) {
      if (
        caughtError
        instanceof RegistrationApiError
      ) {
        setError(caughtError.message);
      } else {
        setError(
          "회원가입 신청 목록을 불러오지 못했습니다.",
        );
      }
    } finally {
      setLoading(false);
    }
  }


  useEffect(() => {
    void loadApplications();
  }, []);


  async function handleApprove(
    application: RegistrationApplication,
  ): Promise<void> {
    setProcessingId(application.id);
    setError("");
    setMessage("");

    try {
      await approveRegistrationApplication(
        application.id,
      );

      setApplications((current) => (
        current.filter(
          (item) => item.id !== application.id,
        )
      ));

      setMessage(
        `${application.name}님의 계정을 승인했습니다.`,
      );
    } catch (caughtError) {
      if (
        caughtError
        instanceof RegistrationApiError
      ) {
        setError(caughtError.message);
      } else {
        setError(
          "회원가입 신청을 승인하지 못했습니다.",
        );
      }
    } finally {
      setProcessingId(null);
    }
  }


  async function handleReject(
    application: RegistrationApplication,
  ): Promise<void> {
    const reason = (
      rejectReasons[application.id]
      ?? ""
    ).trim();

    if (reason.length < 2) {
      setError(
        "거절 사유를 2자 이상 입력하세요.",
      );

      return;
    }

    setProcessingId(application.id);
    setError("");
    setMessage("");

    try {
      await rejectRegistrationApplication(
        application.id,
        reason,
      );

      setApplications((current) => (
        current.filter(
          (item) => item.id !== application.id,
        )
      ));

      setMessage(
        `${application.name}님의 신청을 거절했습니다.`,
      );
    } catch (caughtError) {
      if (
        caughtError
        instanceof RegistrationApiError
      ) {
        setError(caughtError.message);
      } else {
        setError(
          "회원가입 신청을 거절하지 못했습니다.",
        );
      }
    } finally {
      setProcessingId(null);
    }
  }


  return (
    <main className="admin-registration-page">
      <header className="admin-registration-header">
        <div className="admin-registration-title">
          <button
            type="button"
            onClick={onBack}
            aria-label="뒤로 가기"
          >
            ←
          </button>

          <div>
            <span>ADMIN</span>

            <h1>계정 발급 신청 관리</h1>

            <p>
              교직원 신청을 검토하고 계정을 발급합니다.
            </p>
          </div>
        </div>

        <button
          type="button"
          className="admin-registration-refresh"
          onClick={() => {
            void loadApplications();
          }}
          disabled={loading}
        >
          새로고침
        </button>
      </header>

      <section className="admin-registration-content">
        <div className="admin-registration-summary">
          <span>승인 대기</span>

          <strong>
            {applications.length}
          </strong>
        </div>

        <div className="admin-registration-warning">
          제출 문서의 진위 여부는 자동으로 확인되지
          않습니다. 승인 전 신청 정보와 문서를 직접
          확인하세요.
        </div>

        {error && (
          <div
            className="admin-registration-error"
            role="alert"
          >
            {error}
          </div>
        )}

        {message && (
          <div
            className="admin-registration-message"
            role="status"
          >
            {message}
          </div>
        )}

        {loading && (
          <div className="admin-registration-empty">
            신청 목록을 불러오는 중입니다.
          </div>
        )}

        {!loading && applications.length === 0 && (
          <div className="admin-registration-empty">
            <strong>
              대기 중인 신청이 없습니다.
            </strong>

            <p>
              새로운 신청이 접수되면 이곳에 표시됩니다.
            </p>
          </div>
        )}

        {!loading && applications.length > 0 && (
          <div className="admin-registration-list">
            {applications.map((application) => {
              const processing = (
                processingId === application.id
              );

              return (
                <article
                  key={application.id}
                  className="admin-registration-card"
                >
                  <header>
                    <div>
                      <span className="admin-registration-status">
                        승인 대기
                      </span>

                      <h2>
                        {application.name}
                      </h2>

                      <p>
                        {application.school_name}
                      </p>
                    </div>

                    <time>
                      {formatDate(
                        application.created_at,
                      )}
                    </time>
                  </header>

                  <dl className="admin-registration-details">
                    <div>
                      <dt>신청 아이디</dt>

                      <dd>
                        {application.username}
                      </dd>
                    </div>

                    <div>
                      <dt>이메일</dt>

                      <dd>
                        {application.email}
                      </dd>
                    </div>

                    <div>
                      <dt>전화번호</dt>

                      <dd>
                        {application.phone || "미입력"}
                      </dd>
                    </div>

                    <div>
                      <dt>신청 번호</dt>

                      <dd>
                        #{application.id}
                      </dd>
                    </div>
                  </dl>

                  <div className="admin-registration-document">
                    <div>
                      <span>
                        제출 문서
                      </span>

                      <strong>
                        {
                          application.document
                            ?.original_filename
                          ?? "문서 정보 없음"
                        }
                      </strong>
                    </div>

                    {application.document && (
                      <small>
                        {
                          application.document
                            .content_type
                        }
                        {" · "}
                        {formatFileSize(
                          application.document.size,
                        )}
                      </small>
                    )}

                    {application.document
                      && !application.document.deleted_at
                      && (
                        <a
                          className="admin-document-open"
                          href={`/api/admin/registration-applications/${application.id}/document`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${application.document.original_filename} 새 탭에서 열기`}
                        >
                          문서 열기
                        </a>
                      )}
                  </div>

                  <div className="admin-registration-review">
                    <label>
                      <span>
                        거절 사유
                      </span>

                      <input
                        type="text"
                        value={
                          rejectReasons[
                            application.id
                          ] ?? ""
                        }
                        placeholder={
                          "거절할 경우에만 입력하세요."
                        }
                        maxLength={500}
                        disabled={processing}
                        onChange={(event) => {
                          setRejectReasons(
                            (current) => ({
                              ...current,
                              [application.id]:
                                event.target.value,
                            }),
                          );
                        }}
                      />
                    </label>

                    <div className="admin-registration-actions">
                      <button
                        type="button"
                        className="admin-reject-button"
                        disabled={processing}
                        onClick={() => {
                          void handleReject(
                            application,
                          );
                        }}
                      >
                        거절
                      </button>

                      <button
                        type="button"
                        className="admin-approve-button"
                        disabled={processing}
                        onClick={() => {
                          void handleApprove(
                            application,
                          );
                        }}
                      >
                        {processing
                          ? "처리 중…"
                          : "계정 승인"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
